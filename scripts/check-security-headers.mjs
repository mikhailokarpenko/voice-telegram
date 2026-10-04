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
//   * Since BAS-217 the dashboard script is served from a same-origin
//     /static/app.js, so script-src is exactly 'self': no 'unsafe-inline'. This
//     guard asserts that, and also sweeps every .html and markup-bearing
//     .py (inline HTMLResponse) shipped under src/ for
//     inline <script> blocks and inline on*= handlers -- markup that is dead
//     under the CSP and whose usual "fix" is to put 'unsafe-inline' back.
//   * Since BAS-219 no directive may name a remote origin: the Pico CSS build
//     is vendored under /static, so style-src/font-src are same-origin. A CDN
//     in style-src is a supply-chain write into the authenticated admin origin
//     (CSS can exfiltrate DOM content and overlay the admin controls), and the
//     CDN response carried no Subresource Integrity. The served-markup sweep
//     below also fails on any third-party src=/href= subresource.
//     'unsafe-eval' and wildcard hosts stay hard failures.
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
  // BAS-219: no third-party origin anywhere in the policy. The Pico CSS build
  // is vendored under /static, so style/font sources are same-origin. A CDN in
  // style-src is a silent supply-chain write into the authenticated admin
  // origin: CSS alone can exfiltrate DOM content (attribute selectors driving
  // url() fetches) and can reposition/overlay the admin controls.
  "style-src": "'self'",
  "font-src": "'self' data:",
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

  const styleSrc = directives.get("style-src");
  if (styleSrc === undefined) {
    where("CSP is missing style-src");
  } else if (/'unsafe-inline'/.test(styleSrc)) {
    where(`CSP style-src must not allow 'unsafe-inline': "${styleSrc}"`);
  }

  // Whole-policy prohibitions.
  const policy = [...directives].map(([k, v]) => `${k} ${v}`).join("; ");
  if (/'unsafe-eval'/.test(policy)) {
    where("CSP must not allow 'unsafe-eval'");
  }
  if (/(^|[\s;])\*([\s;]|$)/.test(policy) || /\s\*\./.test(policy)) {
    where(`CSP must not contain a wildcard source: "${policy}"`);
  }
  // BAS-219: no remote origin in any directive. Assets are vendored; a host
  // added back here re-opens a third-party write into the admin origin.
  const remote = [...directives].filter(([, v]) => /https?:\/\//.test(v));
  if (remote.length > 0) {
    where(
      `CSP must not allow any remote origin (BAS-219); vendor the asset under /static instead: ${remote
        .map(([k, v]) => `${k} ${v}`)
        .join("; ")}`
    );
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
    // Assert the binding, not the mere presence of the string: this module's
    // docstring names the header several times, so a substring search is
    // satisfied by prose and would pass with the CSP computed and never sent.
    if (!/^\s*"Content-Security-Policy"\s*:\s*CSP\s*,/m.test(src)) {
      where("STATIC_HEADERS must map \"Content-Security-Policy\" to the CSP constant (computing CSP without emitting it is a silent no-op)");
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

// --- served markup must stay inline-free (BAS-217) ---------------------------
// script-src 'self' is only honest if no HTML shipped by this service carries an
// inline <script> or an inline on*= handler -- whether it lives in a .html
// file or in an inline HTMLResponse string. A dashboard page re-added (or a
// dead one left in the tree and re-wired to a route) would execute nothing under
// the CSP -- and the likely "fix" is to put 'unsafe-inline' back. Fail here
// instead, at the file that introduced the inline code.
function htmlFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith(".html") || e.name.endsWith(".py")) out.push(p);
  }
  return out;
}
for (const pkg of packages) {
  const pkgRoot = join(srcRoot, pkg);
  if (!existsSync(pkgRoot)) continue;
  for (const file of htmlFiles(pkgRoot)) {
    const rel = file.slice(repoRoot.length + 1);
    let html = readFileSync(file, "utf8");
    if (file.endsWith(".py")) {
      // A dashboard re-added as an inline HTMLResponse("""...<script>...""")
      // ships exactly the same dead markup as a .html file, so .py sources that
      // actually serve HTML are swept too. Only the triple-quoted literals are
      // inspected -- prose in docstrings and comments that merely *mentions*
      // <script> must not fail the guard.
      if (!/HTMLResponse|text\/html/.test(html)) continue;
      const literals = html.match(/"""[\s\S]*?"""|'''[\s\S]*?'''/g) || [];
      html = literals.filter((lit) => /<(?:html|body|div|table|button|script)\b/i.test(lit)).join("\n");
      if (html === "") continue;
    }
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) {
      fail(`${rel}: inline <script> block is dead under script-src 'self' (BAS-217); move it to a same-origin .js served from /static, or delete the file if unused`);
    }
    if (/\son[a-z]+\s*=\s*["']/i.test(html)) {
      fail(`${rel}: inline on*= event-handler attribute is dead under script-src 'self' (BAS-217); wire it with addEventListener in a served .js`);
    }
    // BAS-219: served markup must not load a subresource from a third party.
    // Under the tightened CSP a remote <link>/<script>/<img> is blocked at
    // runtime, and the tempting "fix" is to allow-list the host again.
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const url = m[1];
      fail(`${rel}: loads a third-party subresource ${url} (BAS-219); vendor it under /static and keep the CSP free of remote origins`);
    }
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
