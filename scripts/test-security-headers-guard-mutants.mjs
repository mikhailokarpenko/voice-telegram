#!/usr/bin/env node
// Mutation audit harness for scripts/check-security-headers.mjs (voice-telegram).
//
// SECURITY-HEADERS-GUARD-AUDIT.md records a hand-run audit. A hand-run audit
// proves the guard was good on the day it was written and nothing after it.
// This is that audit, executable, in the same shape as the other
// *-guard-mutants.mjs harnesses: one real control weakened per mutant, the
// guard must go red, every file restored afterwards (CI runs
// `git diff --exit-code` to prove the tree came back clean).
//
// SCOPE: only files inside THIS repo are mutated.
//
// Run: node scripts/test-security-headers-guard-mutants.mjs  (exit 0 = guard
// catches every mutant)
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-security-headers.mjs");

const FILES = {
  headers: join(root, "src/voice_telegram/security_headers.py"),
  main: join(root, "src/voice_telegram/main.py"),
};

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

const dropDirective = (name) => (s) =>
  s.replace(new RegExp(`^\\s*"${name}[^"]*",\\n`, "m"), "");
const setDirective = (name, value) => (s) =>
  s.replace(new RegExp(`"${name} [^"]*"`), `"${name} ${value}"`);

// [name, file-key, mutate]
const mutants = [
  // ---- CSP directives loosened or dropped ---------------------------------
  ["default-src dropped from the CSP", "headers", dropDirective("default-src")],
  ["connect-src dropped (injected script may beacon transcripts anywhere)", "headers", dropDirective("connect-src")],
  ["connect-src widened to * (exfiltration channel reopened)", "headers", setDirective("connect-src", "*")],
  ["connect-src widened to https: scheme source", "headers", setDirective("connect-src", "'self' https:")],
  ["media-src dropped (recordings exfiltratable)", "headers", dropDirective("media-src")],
  ["media-src widened to a remote host", "headers", setDirective("media-src", "'self' https://evil.example")],
  ["object-src relaxed from 'none' to 'self' (plugin vector)", "headers", setDirective("object-src", "'self'")],
  ["base-uri relaxed from 'none' (<base> hijack of all relative URLs)", "headers", setDirective("base-uri", "'self'")],
  ["frame-ancestors relaxed from 'none' (admin controls clickjackable)", "headers", setDirective("frame-ancestors", "'self'")],
  ["frame-ancestors dropped entirely", "headers", dropDirective("frame-ancestors")],
  ["form-action relaxed to * (credential-posting forms allowed)", "headers", setDirective("form-action", "*")],
  ["form-action dropped entirely", "headers", dropDirective("form-action")],
  ["script-src dropped (silent fallback to default-src)", "headers", dropDirective("script-src")],
  ["script-src allows 'unsafe-inline' (the BAS-217 regression)", "headers", setDirective("script-src", "'self' 'unsafe-inline'")],
  ["script-src allows 'unsafe-eval'", "headers", setDirective("script-src", "'self' 'unsafe-eval'")],
  ["script-src trusts a CDN (supply-chain write into the admin origin)", "headers", setDirective("script-src", "'self' https://cdn.jsdelivr.net")],
  ["script-src allows data: URIs", "headers", setDirective("script-src", "'self' data:")],
  ["style-src dropped entirely", "headers", dropDirective("style-src")],
  ["style-src allows 'unsafe-inline'", "headers", setDirective("style-src", "'self' 'unsafe-inline'")],
  ["style-src re-points at the jsDelivr CDN (BAS-219 regression, no SRI)", "headers", setDirective("style-src", "'self' https://cdn.jsdelivr.net")],
  ["font-src re-points at a CDN", "headers", setDirective("font-src", "'self' data: https://cdn.jsdelivr.net")],
  ["a wildcard subdomain source is added to the policy", "headers", setDirective("img-src", "'self' data: *.example.com")],
  ["the whole CSP constant is emptied", "headers", s => s.replace(/^CSP = "; "\.join\(\n[\s\S]*?^\)$/m, 'CSP = ""')],

  // ---- static headers ------------------------------------------------------
  ["X-Frame-Options downgraded DENY -> SAMEORIGIN", "headers", s => s.replace('"X-Frame-Options": "DENY"', '"X-Frame-Options": "SAMEORIGIN"')],
  ["X-Frame-Options removed", "headers", s => s.replace(/^\s*"X-Frame-Options": "DENY",\n/m, "")],
  ["X-Content-Type-Options nosniff removed (MIME sniffing back)", "headers", s => s.replace(/^\s*"X-Content-Type-Options": "nosniff",\n/m, "")],
  ["Referrer-Policy weakened to unsafe-url (admin URLs leak)", "headers", s => s.replace('"Referrer-Policy": "no-referrer"', '"Referrer-Policy": "unsafe-url"')],
  ["Cross-Origin-Opener-Policy removed (window reference cross-origin)", "headers", s => s.replace(/^\s*"Cross-Origin-Opener-Policy": "same-origin",\n/m, "")],
  ["Cross-Origin-Resource-Policy removed", "headers", s => s.replace(/^\s*"Cross-Origin-Resource-Policy": "same-origin",\n/m, "")],
  ["Permissions-Policy removed entirely", "headers", s => s.replace(/^\s*"Permissions-Policy": "[^"]*",\n/m, "")],
  ["Permissions-Policy no longer denies the microphone", "headers", s => s.replace("microphone=(), ", "")],
  ["Content-Security-Policy no longer emitted (CSP computed, never sent)", "headers", s => s.replace(/^\s*"Content-Security-Policy": CSP,\n/m, "")],

  // ---- the headers must actually be applied --------------------------------
  ["apply_security_headers no longer iterates STATIC_HEADERS (dict defined, never written)", "headers", s =>
    s.replace("    for name, value in STATIC_HEADERS.items():\n        response.headers[name] = value\n", "")],
  ["the STATIC_HEADERS loop body stops assigning onto response.headers", "headers", s =>
    s.replace("        response.headers[name] = value\n", "        pass\n")
     .replace('        response.headers["Strict-Transport-Security"] = HSTS\n', "        pass\n")],
  ["HSTS emitted unconditionally (poisons local http with a year-long pin)", "headers", s =>
    s.replace("    if https:\n        response.headers", '    response.headers["Strict-Transport-Security"] = HSTS\n    if True:\n        response.headers')
     .replace(/    if True:\n        response\.headers\["Strict-Transport-Security"\] = HSTS\n/, "")],
  ["HSTS max-age cut to 10 minutes", "headers", s => s.replace("max-age=31536000", "max-age=600")],
  ["install_security_headers no longer registers the middleware", "headers", s =>
    s.replace('    @app.middleware("http")\n', "    ")],
  ["the middleware stops calling apply_security_headers (returns the raw response)", "headers", s =>
    s.replace("        return apply_security_headers(response, https=https)", "        return response")],
  ["https flag no longer derived from public_base_url (hardcoded False)", "headers", s =>
    s.replace('    https = public_base_url.strip().lower().startswith("https")', "    https = False")],
  ["apply_security_headers removed outright", "headers", s =>
    s.replace(/^def apply_security_headers\([\s\S]*?\n    return response\n/m, "")],
  ["install_security_headers removed outright", "headers", s =>
    s.replace(/^def install_security_headers\([\s\S]*$/m, "")],

  // ---- wiring into the app --------------------------------------------------
  ["main.py stops importing install_security_headers", "main", s =>
    s.replace(/^from [\w.]*security_headers import install_security_headers\n/m, "")],
  ["main.py never calls install_security_headers (import left behind)", "main", s =>
    s.replace(/^\s*install_security_headers\(app, public_base_url=[^\n]*\n/m, "")],
  ["install_security_headers called without public_base_url (HSTS silently wrong)", "main", s =>
    s.replace(/install_security_headers\(app, public_base_url=[^)]*\)/, "install_security_headers(app)")],
];

// Mutants that add a new served-markup file rather than editing an existing one.
const fileMutants = [
  ["a dashboard page with an inline <script> is re-added under src/",
    join(root, "src/voice_telegram/_mutant_dashboard.html"),
    "<html><body><div id=x></div><script>fetch('/admin/calls')</script></body></html>\n"],
  ["a page with an inline on*= handler is re-added under src/",
    join(root, "src/voice_telegram/_mutant_handler.html"),
    `<html><body><button onclick="go()">go</button></body></html>\n`],
  ["a page loading a third-party subresource is re-added under src/",
    join(root, "src/voice_telegram/_mutant_cdn.html"),
    `<html><head><link href="https://cdn.jsdelivr.net/npm/@picocss/pico/css/pico.min.css" rel=stylesheet></head><body></body></html>\n`],
  ["an inline HTMLResponse dashboard with a <script> is re-added as a .py module",
    join(root, "src/voice_telegram/_mutant_page.py"),
    `from starlette.responses import HTMLResponse\n\n\ndef page() -> HTMLResponse:\n    return HTMLResponse("""<html><body><table></table><script>alert(1)</script></body></html>""")\n`],
];

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);

if (!runGuard()) {
  console.error("FAIL - guard is already red on the unmutated tree; the audit would be vacuous");
  process.exit(1);
}

const results = [];
for (const [name, fileKey, mutate] of mutants) {
  const path = FILES[fileKey];
  const original = originals[fileKey];
  let mutated;
  try {
    mutated = mutate(original);
  } catch (err) {
    results.push([name, `MUTATOR-ERROR (${err.message})`]);
    continue;
  }
  if (mutated === original) {
    results.push([name, "NO-OP"]);
    continue;
  }
  try {
    writeFileSync(path, mutated);
    results.push([name, runGuard() ? "ESCAPED" : "caught"]);
  } finally {
    writeFileSync(path, original);
  }
}

for (const [name, path, body] of fileMutants) {
  if (existsSync(path)) {
    results.push([name, "NO-OP (file already present)"]);
    continue;
  }
  try {
    writeFileSync(path, body);
    results.push([name, runGuard() ? "ESCAPED" : "caught"]);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
}

if (!runGuard()) {
  console.error("FAIL - guard is red on the restored tree; mutants were not cleanly reverted");
  process.exit(1);
}


// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied -- or filtered to nothing by a stale
// anchor -- reports "0/0 caught" and exits 0: green while proving nothing.
// That is the same "asserted nothing" defect the guards themselves exist to
// catch, one level up. The floor counts mutants that ACTUALLY EXECUTED, so
// neither deleting entries nor short-circuiting the loop can slip past it.
// It may only be raised. Lowering it is a deliberate reduction in coverage.
const MIN_MUTANTS_EXECUTED = 48;
if ((results.length) < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${results.length} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required. ` +
      "Mutants were removed or skipped; this audit understates the guard's blind spots.",
  );
  process.exit(1);
}
let bad = 0;
for (const [name, status] of results) {
  if (status === "caught") console.log(`ok   - caught: ${name}`);
  else { bad++; console.error(`FAIL - ${status}: ${name}`); }
}
console.log(`\n${results.length - bad}/${results.length} mutants caught; guard green on restored tree.`);
process.exit(bad ? 1 : 0);
