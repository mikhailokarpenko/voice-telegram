#!/usr/bin/env node
// Guard: every voice service must ship the BAS-213 defence-in-depth response
// headers, and the CSP must keep the exfiltration channels shut.
//
// Why this exists:
//   * The stored-XSS fix (check-admin-xss.mjs) escapes the Twilio-controlled
//     call fields. That is one layer. If an escaper ever regresses -- a new
//     column rendered with plain concatenation, a refactor that drops `esc()`
//     -- the payload runs in the authenticated admin origin again.
//   * The headers asserted here cap that blast radius: `connect-src 'self'`
//     and `img-src`/`media-src` pinned to 'self' mean an injected script cannot
//     beacon transcripts or call recordings to an attacker host;
//     `frame-ancestors 'none'` + `X-Frame-Options: DENY` block clickjacking of
//     the admin controls; `object-src`/`base-uri 'none'` kill plugin and <base>
//     hijack tricks; `form-action 'self'` stops credential-posting forms.
//   * The dashboards still use inline <script>/<style> and inline handlers, so
//     script-src/style-src must allow 'unsafe-inline' today. That is a recorded
//     limitation, NOT a licence to also allow 'unsafe-eval', a wildcard host,
//     or the CSS CDN in script-src -- each of those would reopen a channel this
//     guard is here to keep closed. Those are asserted as hard failures.
//
// The guard is static (node-only, no Python/deps) so it runs in the `guards` CI
// job on every push; the pytest suite (tests/test_security_headers.py) covers
// the runtime behaviour.
//
// Run: node scripts/check-security-headers.mjs   (exit 0 = safe)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");

const failures = [];
const fail = (msg) => failures.push(msg);

if (!existsSync(srcRoot)) {
  fail("src/ not found; guard must run from the repo root");
}

const packages = existsSync(srcRoot)
  ? readdirSync(srcRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(srcRoot, e.name, "main.py")))
      .map((e) => e.name)
  : [];

if (packages.length === 0) {
  fail("no python package with a main.py found under src/");
}

// Directives that must be present with exactly this value. These are the ones
// that carry security weight; loosening any of them is the regression.
const REQUIRED_EXACT = {
  "default-src": "'self'",
  "connect-src": "'self'",
  "media-src": "'self'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "frame-ancestors": "'none'",
  "form-action": "'self'",
};

const REQUIRED_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

for (const pkg of packages) {
  const mod = join(srcRoot, pkg, "security_headers.py");
  const main = join(srcRoot, pkg, "main.py");
  const where = (m) => fail(`${pkg}: ${m}`);

  if (!existsSync(mod)) {
    where("src/" + pkg + "/security_headers.py is missing (no CSP on this service)");
    continue;
  }
  const src = readFileSync(mod, "utf8");

  // --- CSP directives -------------------------------------------------------
  // Pull the directive literals out of the CSP list. Each entry is a quoted
  // python string; f-strings are included (style-src/font-src embed the CDN).
  const cspBlock = src.split(/^CSP\s*=/m)[1]?.split(/^\)\s*$/m)[0] ?? "";
  if (!cspBlock) {
    where("no CSP definition found in security_headers.py");
    continue;
  }
  const directives = new Map();
  for (const m of cspBlock.matchAll(/f?"([^"]+)"/g)) {
    const raw = m[1].replace(/\{CDN\}/g, "https://cdn.jsdelivr.net").trim();
    if (!raw || raw === "; ") continue;
    const [name, ...rest] = raw.split(/\s+/);
    directives.set(name, rest.join(" "));
  }

  for (const [name, expected] of Object.entries(REQUIRED_EXACT)) {
    if (!directives.has(name)) {
      where(`CSP is missing the ${name} directive`);
    } else if (directives.get(name) !== expected) {
      where(`CSP ${name} must be exactly "${expected}", found "${directives.get(name)}"`);
    }
  }

  const scriptSrc = directives.get("script-src");
  if (scriptSrc === undefined) {
    where("CSP is missing script-src (falls back to default-src, but be explicit)");
  } else {
    if (/'unsafe-inline'/.test(scriptSrc)) {
      where(`CSP script-src must not allow 'unsafe-inline' (BAS-217): "${scriptSrc}"`);
    }
    if (/cdn\.|https?:\/\//.test(scriptSrc)) {
      where(`CSP script-src must not trust a remote host: "${scriptSrc}"`);
    }
    if (/\bdata:/.test(scriptSrc)) {
      where(`CSP script-src must not allow data: URIs: "${scriptSrc}"`);
    }
  }

  // Whole-policy prohibitions.
  const policy = [...directives].map(([k, v]) => `${k} ${v}`).join("; ");
  if (/'unsafe-eval'/.test(policy)) {
    where("CSP must not allow 'unsafe-eval'");
  }
  if (/(^|[\s;])\*([\s;]|$)/.test(policy) || /\s\*\./.test(policy)) {
    where(`CSP must not contain a wildcard source: "${policy}"`);
  }

  // --- static headers -------------------------------------------------------
  for (const [name, value] of Object.entries(REQUIRED_HEADERS)) {
    const line = src.match(new RegExp(`^\\s*"${name}"\\s*:\\s*"([^"]*)"`, "m"));
    if (!line) where(`STATIC_HEADERS is missing ${name}`);
    else if (line[1] !== value) where(`${name} must be "${value}", found "${line[1]}"`);
  }
  if (!/^\s*"Permissions-Policy"\s*:/m.test(src)) {
    where("STATIC_HEADERS is missing Permissions-Policy");
  } else if (!/microphone=\(\)/.test(src)) {
    where("Permissions-Policy must deny microphone=()");
  }

  // --- the headers must actually be applied --------------------------------
  // Defining STATIC_HEADERS is worthless if nothing writes them onto the
  // response, so require the apply function to loop over them and assign.
  const applyBody = src.split(/def apply_security_headers\s*\(/)[1]?.split(/\ndef /)[0] ?? "";
  if (!applyBody) {
    where("no apply_security_headers() function");
  } else {
    if (!/for\s+\w+\s*,\s*\w+\s+in\s+STATIC_HEADERS\.items\(\)/.test(applyBody)) {
      where("apply_security_headers must iterate STATIC_HEADERS.items()");
    }
    if (!/response\.headers\[[^\]]+\]\s*=/.test(applyBody)) {
      where("apply_security_headers must assign onto response.headers");
    }
    if (!/Content-Security-Policy/.test(src)) {
      where("Content-Security-Policy header is never set");
    }
    // HSTS must be conditional on https, never unconditional (it would poison
    // local http development with a year-long browser pin).
    if (!/if\s+https\s*:/.test(applyBody)) {
      where("Strict-Transport-Security must be gated on `if https:`");
    }
    if (!/max-age=31536000/.test(src)) {
      where("HSTS max-age must be at least one year (31536000)");
    }
  }

  const installBody = src.split(/def install_security_headers\s*\(/)[1] ?? "";
  if (!installBody) {
    where("no install_security_headers() function");
  } else {
    if (!/@app\.middleware\("http"\)/.test(installBody)) {
      where("install_security_headers must register an http middleware");
    }
    if (!/apply_security_headers\(/.test(installBody)) {
      where("the middleware must call apply_security_headers");
    }
    if (!/startswith\("https"\)/.test(installBody)) {
      where("install_security_headers must derive `https` from public_base_url");
    }
  }

  // --- wired into the app ---------------------------------------------------
  if (!existsSync(main)) {
    where("main.py not found");
    continue;
  }
  const mainSrc = readFileSync(main, "utf8");
  if (!/from\s+[\w.]*security_headers\s+import\s+install_security_headers/.test(mainSrc)) {
    where("main.py does not import install_security_headers");
  }
  if (!/install_security_headers\(\s*app\s*,/.test(mainSrc)) {
    where("main.py never calls install_security_headers(app, ...)");
  }
  if (!/install_security_headers\(\s*app\s*,\s*public_base_url\s*=/.test(mainSrc)) {
    where("install_security_headers must be passed public_base_url= so HSTS is correct");
  }
}

if (failures.length > 0) {
  console.error("check-security-headers: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `check-security-headers: OK (${packages.join(", ")}: CSP locks connect/media/object/base-uri, no wildcard or unsafe-eval, headers applied and wired into main.py)`
);
