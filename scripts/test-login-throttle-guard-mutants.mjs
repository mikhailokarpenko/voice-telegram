#!/usr/bin/env node
// Mutation audit for scripts/check-login-throttle.mjs (voice-telegram).
//
// The guard is regexes/block-extraction over admin/auth.py, admin/routes.py,
// main.py and tests/test_admin.py. Regexes see
// text, not behaviour, so the guard proves nothing until it is shown RED
// against code that has actually lost the brute-force / proxy-trust controls.
//
// Each mutant removes exactly one real control and leaves the rest of the tree
// intact. A mutant that does not change any file is reported NO-OP and never
// counted as caught -- that is how a stale mutant (anchored on text that has
// since moved) is prevented from silently inflating the score.
//
// Run: node scripts/test-login-throttle-guard-mutants.mjs   (exit 0 = guard
// catches every mutant)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-login-throttle.mjs");

// voice-telegram calls uvicorn.run(forwarded_allow_ips=...) from main.py
// rather than passing --forwarded-allow-ips on a Dockerfile/compose command
// line, so the proxy-trust mutants all land in main.py here.
const FILES = {
  auth: join(root, "src/voice_telegram/admin/auth.py"),
  routes: join(root, "src/voice_telegram/admin/routes.py"),
  main: join(root, "src/voice_telegram/main.py"),
  tests: join(root, "tests/test_admin.py"),
};

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

// Insert `stmt` as the first statement of a def body, walking to the end of a
// possibly multi-line signature so the statement never lands in the arg list.
const shortCircuit = (src, sig, stmt, indent = "    ") => {
  const i = src.indexOf(sig);
  if (i < 0) return src;
  let j = i;
  let depth = 0;
  for (;;) {
    const nl = src.indexOf("\n", j);
    if (nl < 0) return src;
    const line = src.slice(j, nl);
    depth += (line.match(/[([{]/g) || []).length - (line.match(/[)\]}]/g) || []).length;
    if (depth <= 0 && /:\s*$/.test(line)) {
      const base = /^(\s*)/.exec(src.slice(i))[1];
      return src.slice(0, nl + 1) + `${base}${indent}${stmt}\n` + src.slice(nl + 1);
    }
    j = nl + 1;
  }
};

// [name, file-key, mutate]
const mutants = [
  // ---- the throttle class is gone / gutted -------------------------------
  ["LoginThrottle renamed (every call site would be rewired by the attacker)", "auth", s =>
    s.replace("class LoginThrottle:", "class RequestCounter:")],
  ["LoginThrottle.check() deleted", "auth", s =>
    s.replace(/\n    def check\(self, client: str, now: datetime \| None = None\) -> None:[\s\S]*?\n    def record_failure/, "\n    def record_failure")],
  ["LoginThrottle._prune() deleted", "auth", s =>
    s.replace(/\n    def _prune\(self[\s\S]*?\n    def check/, "\n    def check")],
  ["LoginThrottle.record_failure() deleted", "auth", s =>
    s.replace(/\n    def record_failure\(self[\s\S]*?\n    def record_success/, "\n    def record_success")],

  // ---- lockout condition neutralised ------------------------------------
  ["check() never locks out (condition ANDed with False)", "auth", s =>
    s.replace("if len(stamps) >= self.max_failures or len(self._global) >= self.global_max_failures:",
      "if (len(stamps) >= self.max_failures or len(self._global) >= self.global_max_failures) and False:")],
  ["per-client half of the lockout dropped (single host unlimited)", "auth", s =>
    s.replace("if len(stamps) >= self.max_failures or len(self._global) >= self.global_max_failures:",
      "if len(self._global) >= self.global_max_failures:")],
  ["global half of the lockout dropped (distributed spray unbounded)", "auth", s =>
    s.replace("if len(stamps) >= self.max_failures or len(self._global) >= self.global_max_failures:",
      "if len(stamps) >= self.max_failures:")],
  ["check() short-circuits to a bare return before any counting", "auth", s =>
    shortCircuit(s, "    def check(self, client: str", "return None", "    ")],
  ["429 downgraded: check() logs instead of raising", "auth", s =>
    s.replace(/            raise HTTPException\(\n                status\.HTTP_429_TOO_MANY_REQUESTS,\n                "Too many failed login attempts",\n                headers=\{"Retry-After": retry_after\},\n            \)/,
      '            log.warning("throttled %s retry_after=%s HTTP_429_TOO_MANY_REQUESTS Retry-After", client, retry_after)')],
  ["Retry-After header dropped from the 429", "auth", s =>
    s.replace('                headers={"Retry-After": retry_after},\n', "")],

  // ---- bounds: structurally present, operationally absent ----------------
  ["max_failures default raised to 10_000_000", "auth", s =>
    s.replace("max_failures: int = 5,", "max_failures: int = 10_000_000,")],
  ["global_max_failures default raised to 10_000_000", "auth", s =>
    s.replace("global_max_failures: int = 50,", "global_max_failures: int = 10_000_000,")],
  ["window_seconds collapsed to 0 (every bucket always empty)", "auth", s =>
    s.replace("window_seconds: int = 300,", "window_seconds: int = 0,")],
  ["max_failures set to 0 (lockout before any attempt: DoS, not a throttle)", "auth", s =>
    s.replace("max_failures: int = 5,", "max_failures: int = 0,")],

  // ---- pruning sabotage --------------------------------------------------
  ["_prune() returns [] (buckets are always empty, no lockout ever)", "auth", s =>
    s.replace("        cutoff = now - self.window\n        return [s for s in stamps if s > cutoff]",
      "        cutoff = now - self.window\n        return []")],
  ["_prune() cutoff no longer derived from the configured window", "auth", s =>
    s.replace("cutoff = now - self.window", "cutoff = now - timedelta(seconds=1)")],
  ["check() stops pruning/reading the global bucket", "auth", s =>
    s.replace("        self._global = self._prune(self._global, now)\n", "")],

  // ---- recording sabotage ------------------------------------------------
  ["record_failure() no longer records per-client", "auth", s =>
    s.replace("        self._failures.setdefault(client, []).append(now)\n", "")],
  ["record_failure() no longer records globally", "auth", s =>
    s.replace("        self._global.append(now)\n", "")],
  ["record_success() no longer clears the client's bucket", "auth", s =>
    s.replace("    def record_success(self, client: str) -> None:\n        self._failures.pop(client, None)",
      "    def record_success(self, client: str) -> None:\n        return None")],

  // ---- wiring in the app -------------------------------------------------
  ["login throttle never installed on app.state", "main", s =>
    s.replace("app.state.login_throttle = LoginThrottle()", "app.state.login_throttle = None")],

  // ---- wiring in the login handler --------------------------------------
  ["login no longer calls throttle.check()", "routes", s =>
    s.replace("    throttle.check(client)\n", "")],
  ["throttle.check() moved AFTER verify_password() (lockout becomes a password oracle)", "routes", s =>
    s.replace("    throttle.check(client)\n    if not verify_password(body.password, settings):",
      "    if not verify_password(body.password, settings):\n        throttle.check(client)")],
  ["failed logins no longer counted", "routes", s =>
    s.replace("        throttle.record_failure(client)\n", "")],
  ["successful logins no longer clear the bucket", "routes", s =>
    s.replace("    throttle.record_success(client)\n", "")],
  ["bucket key is the submitted password (attacker-chosen: fresh bucket per guess)", "routes", s =>
    s.replace('    client = request.client.host if request.client else "unknown"',
      "    client = body.password")],
  ["bucket key read from the raw X-Forwarded-For header, bypassing the proxy trust list", "routes", s =>
    s.replace('    client = request.client.host if request.client else "unknown"',
      '    client = request.headers.get("x-forwarded-for", "unknown")')],
  ["check() keyed on a constant while record_failure() keeps the client key", "routes", s =>
    s.replace("    throttle.check(client)", '    throttle.check("global")')],
  ["record_failure() keyed on a constant while check() keeps the client key", "routes", s =>
    s.replace("        throttle.record_failure(client)", '        throttle.record_failure("global")')],

  // ---- the XFF / proxy-trust boundary (BAS-221 / BAS-223) ---------------
  ["uvicorn.run() stops pinning forwarded_allow_ips (uvicorn default trusts 127.0.0.1 only -- but the resolver fail-safe is bypassed)", "main", s =>
    s.replace("        forwarded_allow_ips=resolve_trusted_proxy_ips(),\n", "")],
  ["uvicorn.run() forwarded_allow_ips hard-coded to the wildcard", "main", s =>
    s.replace("forwarded_allow_ips=resolve_trusted_proxy_ips()", 'forwarded_allow_ips="*"')],
  ["TRUSTED_PROXY_IPS constant widened to 0.0.0.0/0", "main", s =>
    s.replace('TRUSTED_PROXY_IPS = "127.0.0.1,::1"', 'TRUSTED_PROXY_IPS = "0.0.0.0/0"')],
  ["TRUSTED_PROXY_IPS constant widened to the private ranges", "main", s =>
    s.replace('TRUSTED_PROXY_IPS = "127.0.0.1,::1"',
      'TRUSTED_PROXY_IPS = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fd00::/8"')],
  ["TRUSTED_PROXY_IPS constant set to the wildcard", "main", s =>
    s.replace('TRUSTED_PROXY_IPS = "127.0.0.1,::1"', 'TRUSTED_PROXY_IPS = "*"')],
  ["TRUSTED_PROXY_IPS constant emptied", "main", s =>
    s.replace('TRUSTED_PROXY_IPS = "127.0.0.1,::1"', 'TRUSTED_PROXY_IPS = ""')],
  ["resolver no longer rejects a wildcard TRUSTED_PROXY_IPS", "main", s =>
    s.replace(/    if "\*" in resolved:\n        raise ValueError\(\n[\s\S]*?\n        \)\n/, "")],
  ["resolver detects the wildcard but no longer raises (logs and continues)", "main", s =>
    s.replace("        raise ValueError(", "        _ = (")],
  ["resolver stops reading the TRUSTED_PROXY_IPS env var (override silently ignored)", "main", s =>
    s.replace('resolved = (value if value is not None else os.environ.get("TRUSTED_PROXY_IPS")) or ""',
      'resolved = (value if value is not None else None) or ""')],
  ["import-time fail-fast resolve_trusted_proxy_ips() call removed", "main", s =>
    s.replace(/^resolve_trusted_proxy_ips\(\)$/m, "# resolve_trusted_proxy_ips()")],
  ["resolve_trusted_proxy_ips() deleted outright", "main", s =>
    s.replace(/^def resolve_trusted_proxy_ips[\s\S]*?\n    return ",".join\(entries\)\n/m, "")],

  // ---- BAS-223: deploy-time override may not re-bless a whole range -----
  ["resolver drops the CIDR entry check (TRUSTED_PROXY_IPS=172.16.0.0/12 accepted)", "main", s =>
    s.replace(/        if "\/" in entry:\n            raise ValueError\(\n[\s\S]*?\n            \)\n/, "")],
  ["resolver stops parsing entries as exact IP addresses", "main", s =>
    s.replace(/        try:\n            parsed = ipaddress\.ip_address\(entry\)\n[\s\S]*?from exc\n/, "            parsed = None\n")],
  ["resolver stops rejecting the unspecified address", "main", s =>
    s.replace(/        if parsed\.is_unspecified:\n            raise ValueError\(\n[\s\S]*?\n            \)\n/, "")],
  ["CIDR/private-range rejection test removed", "tests", s =>
    s.replace("def test_private_range_trusted_proxy_ips_is_rejected(", "def _disabled_cidr_test(")],
  ["CIDR test no longer asserts the resolver raises", "tests", s =>
    s.replace(/        with pytest\.raises\(ValueError\):\n            resolve_trusted_proxy_ips\(\)/, "        resolve_trusted_proxy_ips")],
  ["CIDR test narrowed to drop the 172.16/12 range", "tests", s =>
    s.replace('        "172.16.0.0/12",', '        "198.51.100.0/24",')],
  // ---- regression tests deleted / defanged ------------------------------
  ["brute-force regression test removed", "tests", s =>
    s.replace("def test_login_throttles_brute_force_and_clears_on_success(", "def _disabled_brute_force(")],
  ["brute-force test no longer asserts a 429 lockout", "tests", s => {
    const i = s.indexOf("def test_login_throttles_brute_force_and_clears_on_success(");
    if (i < 0) return s;
    const j = s.indexOf("\ndef ", i + 1);
    const body = s.slice(i, j < 0 ? s.length : j);
    return s.slice(0, i) + body.replace(/429/g, "401") + s.slice(j < 0 ? s.length : j);
  }],
  ["window-expiry / global-cap regression test removed", "tests", s =>
    s.replace("def test_login_throttle_window_expiry_and_global_cap(", "def _disabled_window_expiry(")],
  ["X-Forwarded-For bucket-rotation regression test removed", "tests", s =>
    s.replace("def test_spoofed_x_forwarded_for_cannot_rotate_the_throttle_bucket(", "def _disabled_xff(")],
  ["XFF test no longer runs against the deployed TRUSTED_PROXY_IPS list", "tests", s => {
    const i = s.indexOf("def test_spoofed_x_forwarded_for_cannot_rotate_the_throttle_bucket(");
    if (i < 0) return s;
    const j = s.indexOf("\ndef ", i + 1);
    const body = s.slice(i, j < 0 ? s.length : j);
    return s.slice(0, i) + body.replace(/TRUSTED_PROXY_IPS/g, '"127.0.0.1"') + s.slice(j < 0 ? s.length : j);
  }],
  ["private-range peer regression test removed (loopback-only default unproven)", "tests", s =>
    s.replace("def test_private_range_peer_cannot_rotate_the_throttle_bucket(", "def _disabled_private_peer(")],
  ["private-range peer test narrowed to loopback peers only", "tests", s =>
    s.replace('@pytest.mark.parametrize("peer", ["172.20.0.3", "10.1.2.3", "192.168.1.7", "203.0.113.9"])',
      '@pytest.mark.parametrize("peer", ["127.0.0.1", "::1"])')],
  ["private-range peer test stops exercising the 172.16/12 range", "tests", s =>
    s.replace('["172.20.0.3", "10.1.2.3", "192.168.1.7", "203.0.113.9"]',
      '["10.1.2.3", "192.168.1.7", "203.0.113.9"]')],
  ["wildcard TRUSTED_PROXY_IPS rejection test removed", "tests", s =>
    s.replace("def test_wildcard_trusted_proxy_ips_is_rejected(", "def _disabled_wildcard(")],
  ["wildcard test no longer asserts the resolver raises", "tests", s => {
    const i = s.indexOf("def test_wildcard_trusted_proxy_ips_is_rejected(");
    if (i < 0) return s;
    const j = s.indexOf("\ndef ", i + 1);
    const body = s.slice(i, j < 0 ? s.length : j);
    return s.slice(0, i) + body.replace(/raises\(ValueError\)/g, "warns(UserWarning)") + s.slice(j < 0 ? s.length : j);
  }],
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
const MIN_MUTANTS_EXECUTED = 56;
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
