#!/usr/bin/env node
// Guard: the voice-telegram admin login must stay brute-force throttled.
//
// Why: /api/admin/login authenticates against ONE shared admin password
// (Settings.admin_password). With no throttle, an unauthenticated attacker who
// can reach the app has an unlimited online guessing oracle against that single
// secret -- and a win is full admin takeover (rewrite the agent prompt, read
// every transcript and recording, and impersonate the admin UI). The throttle must also run BEFORE the password
// comparison, otherwise a locked-out attacker can still distinguish a correct
// guess from a wrong one by the response.
//
// Mutation-audited: see scripts/LOGIN-THROTTLE-GUARD-AUDIT.md. The previous
// revision of this file was green against nine mutants that disabled the
// throttle (`if False:`, max_failures=10_000_000, record_failure() -> pass,
// `_prune() -> []`, 429 downgraded to 200 with the token surviving in a
// comment, ...) because it grepped whole-file for tokens instead of reading
// the relevant Python blocks. Every assertion below runs against an extracted
// block whose existence is itself asserted, so a renamed/removed block is a
// FAILURE and never a vacuous pass.
//
// Run: node scripts/check-login-throttle.mjs   (exit 0 = safe)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pyBlock, stripComments, intDefault } from "./lib-py-blocks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => stripComments(readFileSync(join(root, p), "utf8"));
const auth = read("src/voice_telegram/admin/auth.py");
const main = read("src/voice_telegram/main.py");
const routes = read("src/voice_telegram/admin/routes.py");
const tests = read("tests/test_admin.py");

const failures = [];
const assert = (cond, msg) => { if (!cond) failures.push(msg); };

// ---- the throttle itself -------------------------------------------------
const cls = pyBlock(auth, "class", "LoginThrottle");
assert(cls, "src/voice_telegram/admin/auth.py: class LoginThrottle is gone (renamed or deleted)");
if (cls) {
  assert(cls.length > 400, "src/voice_telegram/admin/auth.py: LoginThrottle body is suspiciously small -- gutted?");

  const check = pyBlock(cls, "def", "check");
  assert(check, "src/voice_telegram/admin/auth.py: LoginThrottle.check() is gone");
  if (check) {
    // The lockout condition must test BOTH buckets. `if False:`, or dropping
    // either half, is an unlimited oracle for a single host or for a spray.
    assert(/len\(stamps\)\s*>=\s*self\.max_failures/.test(check),
      "src/voice_telegram/admin/auth.py: check() no longer locks out on the per-client failure count");
    assert(/len\(self\._global\)\s*>=\s*self\.global_max_failures/.test(check),
      "src/voice_telegram/admin/auth.py: check() no longer locks out on the global (distributed-spray) count");
    assert(/\braise HTTPException\(/.test(check),
      "src/voice_telegram/admin/auth.py: check() no longer raises -- lockout is not enforced");
    assert(/status\.HTTP_429_TOO_MANY_REQUESTS/.test(check),
      "src/voice_telegram/admin/auth.py: check() no longer raises 429 (comments are stripped before this test)");
    assert(/headers=\{\s*"Retry-After"/.test(check),
      "src/voice_telegram/admin/auth.py: the 429 no longer carries a Retry-After header");
    assert(/self\._prune\(self\._global/.test(check) && /self\._prune\(self\._failures/.test(check),
      "src/voice_telegram/admin/auth.py: check() no longer prunes both buckets to the window");
  }

  const prune = pyBlock(cls, "def", "_prune");
  assert(prune, "src/voice_telegram/admin/auth.py: LoginThrottle._prune() is gone");
  // `return []` prunes everything -> the buckets are always empty -> no lockout.
  assert(prune && /return\s*\[\s*s\s+for\s+s\s+in\s+stamps\s+if\s+s\s*>\s*cutoff\s*\]/.test(prune),
    "src/voice_telegram/admin/auth.py: _prune() no longer returns exactly the in-window stamps");
  assert(prune && /cutoff\s*=\s*now\s*-\s*self\.window/.test(prune),
    "src/voice_telegram/admin/auth.py: _prune() no longer derives its cutoff from the configured window");

  const rf = pyBlock(cls, "def", "record_failure");
  assert(rf, "src/voice_telegram/admin/auth.py: LoginThrottle.record_failure() is gone");
  if (rf) {
    assert(/self\._failures\.setdefault\([^)]*\)\.append\(/.test(rf),
      "src/voice_telegram/admin/auth.py: record_failure() no longer records into the per-client bucket");
    assert(/self\._global\.append\(/.test(rf),
      "src/voice_telegram/admin/auth.py: record_failure() no longer records into the global bucket (spray is unbounded)");
  }

  const rs = pyBlock(cls, "def", "record_success");
  assert(rs && /self\._failures\.pop\(/.test(rs),
    "src/voice_telegram/admin/auth.py: record_success() no longer clears the client's bucket");

  // Bounds: a throttle configured to 10_000_000 failures, or a zero-length
  // window, is structurally present and operationally absent.
  const maxF = intDefault(cls, "max_failures");
  const globalF = intDefault(cls, "global_max_failures");
  const win = intDefault(cls, "window_seconds");
  assert(maxF !== null && maxF >= 1 && maxF <= 50,
    `src/voice_telegram/admin/auth.py: max_failures default (${maxF}) outside a throttling range of 1..50`);
  assert(globalF !== null && globalF >= 1 && globalF <= 5000,
    `src/voice_telegram/admin/auth.py: global_max_failures default (${globalF}) outside a throttling range of 1..5000`);
  assert(win !== null && win >= 30 && win <= 86400,
    `src/voice_telegram/admin/auth.py: window_seconds default (${win}) outside a throttling range of 30..86400`);
}

// ---- wiring in the login handler ----------------------------------------
assert(/app\.state\.login_throttle\s*=\s*LoginThrottle\(/.test(main),
  "src/voice_telegram/src/voice_telegram/admin/routes.py: login throttle is not installed on app.state");

const login = pyBlock(routes, "def", "login");
assert(login, "src/voice_telegram/admin/routes.py: the login handler is gone (renamed?)");
if (login) {
  const checkAt = login.indexOf("throttle.check(");
  const verifyAt = login.indexOf("verify_password(");
  assert(checkAt !== -1, "src/voice_telegram/admin/routes.py: login no longer calls throttle.check()");
  assert(verifyAt !== -1, "src/voice_telegram/admin/routes.py: login no longer verifies the password");
  assert(checkAt !== -1 && verifyAt !== -1 && checkAt < verifyAt,
    "src/voice_telegram/admin/routes.py: throttle.check() must run BEFORE verify_password() (lockout must not be a password oracle)");
  assert(/throttle\.record_failure\(/.test(login),
    "src/voice_telegram/admin/routes.py: failed logins are no longer counted");
  assert(/throttle\.record_success\(/.test(login),
    "src/voice_telegram/admin/routes.py: successful logins no longer clear the bucket");
  // The bucket key must be the peer address. Keying on anything
  // attacker-chosen (e.g. the submitted password) gives every guess a fresh
  // bucket and the per-client limit never fires.
  assert(/request\.client\.host\s+if\s+request\.client\s+else/.test(login),
    "src/voice_telegram/admin/routes.py: the throttle bucket key is no longer the client address");
  const clientLine = /^\s*client\s*=\s*(.+)$/m.exec(login);
  assert(clientLine && /request\.client\.host/.test(clientLine[1]),
    "src/voice_telegram/admin/routes.py: `client` is no longer derived from request.client.host");
  const keyed = /throttle\.check\(\s*client\b/.test(login) &&
    /throttle\.record_failure\(\s*client\b/.test(login);
  assert(keyed, "src/voice_telegram/admin/routes.py: throttle calls are no longer keyed on `client`");
}

// ---- regression tests ----------------------------------------------------
assert(/def test_login_throttles_brute_force_and_clears_on_success\b/.test(tests),
  "tests/test_admin.py: the login brute-force regression test was removed");
assert(/def test_login_throttle_window_expiry_and_global_cap\b/.test(tests),
  "tests/test_admin.py: the window-expiry / global-cap regression test was removed");
const brute = pyBlock(tests, "def", "test_login_throttles_brute_force_and_clears_on_success");
assert(brute && /status_code\s*==\s*429/.test(brute),
  "tests/test_admin.py: the brute-force test no longer asserts a 429 lockout");
assert(brute && /retry-after/i.test(brute),
  "tests/test_admin.py: the brute-force test no longer asserts Retry-After");
const cap = pyBlock(tests, "def", "test_login_throttle_window_expiry_and_global_cap");
assert(cap && /global_max_failures\s*=/.test(cap),
  "tests/test_admin.py: the global-cap test no longer exercises global_max_failures");

// ---- deployment: the XFF trust boundary ---------------------------------
// The per-client bucket is keyed on request.client.host, which uvicorn's
// ProxyHeadersMiddleware overwrites from X-Forwarded-For when the peer is
// trusted. With --forwarded-allow-ips=* EVERY peer is trusted, so an
// unauthenticated attacker rotates X-Forwarded-For and gets a fresh bucket per
// guess: the per-client half of the throttle is void and only the global cap
// remains. Verified empirically (40 guesses, 0 lockouts) before this guard
// existed. So: proxy-header trust must be pinned to specific addresses.
{
  const files = ["src/voice_telegram/main.py", "Dockerfile", "compose.yaml"];
  let sawAny = false;
  for (const rel of files) {
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { continue; }
    const hits = [...text.matchAll(/forwarded[-_]allow[-_]ips\s*[=:]\s*("?)([^"',\s\]]*(?:,[^"'\s\]]*)*)\1/gi)];
    for (const m of hits) {
      sawAny = true;
      let value = m[2].trim().replace(/[,)\]]+$/, "");
      // Resolve one level of indirection: `forwarded_allow_ips=TRUSTED_PROXY_IPS`
      // with `TRUSTED_PROXY_IPS = "*"` is the same vulnerability, so follow the
      // constant instead of blessing the identifier.
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        const decl = new RegExp("^\\s*" + value + "\\s*(?::[^=]+)?=\\s*[\"']([^\"']*)[\"']", "m").exec(text);
        assert(decl, `${rel}: --forwarded-allow-ips is set from \`${value}\`, whose literal value could not be resolved in this file`);
        if (!decl) continue;
        value = decl[1].trim();
      }
      assert(value !== "*" && value !== "'*'",
        `${rel}: --forwarded-allow-ips=* trusts X-Forwarded-For from every peer, which lets an attacker rotate the login throttle's bucket key (pin it to the reverse-proxy addresses)`);
      assert(value.length > 0,
        `${rel}: --forwarded-allow-ips is empty`);
    }
  }
  assert(sawAny,
    "deployment: no --forwarded-allow-ips setting found in " + files.join(", ") +
    " -- if proxy-header handling moved, re-point this guard at it");
}

assert(/def test_spoofed_x_forwarded_for_cannot_rotate_the_throttle_bucket\b/.test(tests),
  "tests/test_admin.py: the X-Forwarded-For bucket-rotation regression test was removed");
{
  const xff = pyBlock(tests, "def", "test_spoofed_x_forwarded_for_cannot_rotate_the_throttle_bucket");
  assert(xff && /TRUSTED_PROXY_IPS/.test(xff),
    "tests/test_admin.py: the XFF test no longer runs against the deployed TRUSTED_PROXY_IPS trust list");
  assert(xff && /X-Forwarded-For/.test(xff) && /429/.test(xff),
    "tests/test_admin.py: the XFF test no longer asserts a 429 under a rotating X-Forwarded-For");
}

if (failures.length) {
  console.error("check-login-throttle: FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-login-throttle: OK (admin login throttled per-client + globally, before password comparison)");
