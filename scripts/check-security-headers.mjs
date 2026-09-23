#!/usr/bin/env node
// Guard: every voice service must install the security-response-header
// middleware, and the CSP must keep the exfiltration channels closed.
//
// Why this exists (BAS-213 follow-up):
//   The admin dashboards render call fields that an attacker controls end to
//   end (Twilio `From`/`To`/`CallSid` from the inbound webhook form, provider
//   `error` strings). Those are escaped now, but escaping is one line of code
//   away from regressing. The headers are the second layer:
//     * `connect-src`/`img-src`/`media-src 'self'` -> an injected payload has
//       no outbound channel for transcripts, recordings or the agent prompt.
//     * `object-src`/`base-uri 'none'` -> no plugin or <base> hijack.
//     * `frame-ancestors 'none'` + `X-Frame-Options: DENY` -> the admin
//       controls (PUT /api/admin/config) cannot be clickjacked.
//     * `form-action 'self'` -> no credential-posting form to an attacker host.
//   `script-src`/`style-src` still need 'unsafe-inline' because the dashboards
//   are single-file inline HTML; that is a known, deliberate limitation and is
//   asserted here so it cannot silently widen further (no `*`, no
//   'unsafe-eval', and the CSS CDN must never appear in `script-src`).
//
// Run: node scripts/check-security-headers.mjs   (exit 0 = safe)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const selfRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const siblingRoot = join(selfRoot, "..");

// repoDir -> { module, app } paths relative to the repo root
const REPOS = {
  "voice-phone": {
    module: "src/voice_agent/security_headers.py",
    app: "src/voice_agent/main.py",
  },
  "voice-telegram": {
    module: "src/voice_telegram/security_headers.py",
    app: "src/voice_telegram/main.py",
  },
  "voice-web": {
    module: "src/voice_web/security_headers.py",
    app: "src/voice_web/main.py",
  },
};

const failures = [];
const notes = [];
const check = (name, ok, detail = "") => {
  if (ok) notes.push(`  ok   ${name}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

const REQUIRED_DIRECTIVES = {
  "default-src": "'self'",
  "connect-src": "'self'",
  "media-src": "'self'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "frame-ancestors": "'none'",
  "form-action": "'self'",
};

const REQUIRED_HEADERS = [
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Permissions-Policy", null],
];

function resolveRepo(dir) {
  // Works both from inside the repo itself and from the voice-suite layout.
  if (existsSync(join(selfRoot, REPOS[dir].module))) {
    // selfRoot IS this repo — only if the package name matches.
    const own = Object.keys(REPOS).filter((d) =>
      existsSync(join(selfRoot, REPOS[d].module)),
    );
    if (own.includes(dir)) return selfRoot;
  }
  const sibling = join(siblingRoot, dir);
  if (existsSync(join(sibling, REPOS[dir].module))) return sibling;
  return null;
}

let checkedAny = false;

for (const [dir, rel] of Object.entries(REPOS)) {
  const root = resolveRepo(dir);
  if (!root) {
    notes.push(`  skip ${dir} (not present in this checkout)`);
    continue;
  }
  checkedAny = true;

  const modulePath = join(root, rel.module);
  const appPath = join(root, rel.app);
  if (!existsSync(appPath)) {
    check(`${dir}: ${rel.app} exists`, false, "application entrypoint missing");
    continue;
  }

  const mod = readFileSync(modulePath, "utf8");
  const app = readFileSync(appPath, "utf8");

  // 1. The app must actually install the middleware.
  check(
    `${dir}: main.py imports install_security_headers`,
    /from\s+\S+\.security_headers\s+import\s+install_security_headers/.test(app),
  );
  check(
    `${dir}: main.py calls install_security_headers(app, public_base_url=...)`,
    /install_security_headers\(\s*app\s*,\s*public_base_url\s*=/.test(app),
    "middleware defined but never attached would ship zero headers",
  );

  // 2. CSP directives.
  const cspBlock = mod.slice(mod.indexOf("CSP = "), mod.indexOf("STATIC_HEADERS"));
  if (!cspBlock) {
    check(`${dir}: CSP literal found`, false);
    continue;
  }
  for (const [directive, value] of Object.entries(REQUIRED_DIRECTIVES)) {
    check(
      `${dir}: CSP ${directive} ${value}`,
      cspBlock.includes(`"${directive} ${value}"`),
    );
  }
  check(`${dir}: CSP has no wildcard source`, !cspBlock.includes("*"));
  check(`${dir}: CSP has no 'unsafe-eval'`, !cspBlock.includes("unsafe-eval"));

  const scriptSrc = (cspBlock.match(/"script-src[^"]*"/) || [""])[0];
  check(`${dir}: script-src present`, scriptSrc.length > 0);
  check(
    `${dir}: CSS CDN is not a script source`,
    !scriptSrc.includes("cdn.jsdelivr.net") && !scriptSrc.includes("{CDN}"),
    "allow-listing the CDN for scripts would reopen the XSS path",
  );

  // 3. Non-CSP headers.
  for (const [header, value] of REQUIRED_HEADERS) {
    const line = mod.match(new RegExp(`"${header}":\\s*"([^"]*)"`));
    check(
      `${dir}: ${header}${value ? ` = ${value}` : ""}`,
      Boolean(line) && (value === null || line[1] === value),
      line ? `got "${line[1]}"` : "header absent",
    );
  }

  // 4. HSTS must be conditional on https, not unconditional (breaks local dev)
  //    and not absent (needed in production).
  check(
    `${dir}: HSTS emitted only for https deployments`,
    /if\s+https:\s*\n\s*response\.headers\["Strict-Transport-Security"\]/.test(mod),
  );

  // 5. The middleware must set headers AFTER call_next, so downstream
  //    responses (including error responses) are covered.
  check(
    `${dir}: headers applied to every response (after call_next)`,
    /response\s*=\s*await\s+call_next\(request\)[\s\S]{0,200}apply_security_headers/.test(mod),
  );
}

if (!checkedAny) {
  failures.push("  FAIL no voice service package found — guard would pass vacuously");
}

for (const n of notes) console.log(n);
if (failures.length) {
  console.error("\nSecurity header guard FAILED:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nSecurity header guard OK");
