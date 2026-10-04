#!/usr/bin/env node
// Mutation audit harness for scripts/check-admin-config.mjs (voice-telegram).
//
// ADMIN-CONFIG-GUARD-AUDIT.md records a hand-run audit. A hand-run audit proves
// the guard was good on the day it was written and nothing after that. This is
// that audit, executable, in the same shape as the other *-guard-mutants.mjs
// harnesses: one real control removed per mutant, the guard must go red, every
// file restored afterwards (CI runs `git diff --exit-code` to prove it).
//
// SCOPE: only files inside THIS repo are mutated. The guard also inspects a
// sibling voice-phone checkout when one is present; that is a different git
// repo, so mutating it here would leave dirt the restore check cannot see.
//
// Run: node scripts/test-admin-config-guard-mutants.mjs  (exit 0 = guard catches
// every mutant)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-admin-config.mjs");

const FILES = {
  config: join(root, "src/voice_telegram/config.py"),
  env: join(root, ".env.example"),
};

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

const VALIDATOR_HEAD = `    @model_validator(mode="after")
    def require_admin_credentials(self) -> "Settings":
`;

// [name, file-key, mutate]
const mutants = [
  // ---- generated / non-empty defaults come back --------------------------
  ["admin_jwt_secret default regenerated per process (the original BAS defect)", "config", s =>
    s.replace('    admin_jwt_secret: str = ""',
      "    admin_jwt_secret: str = secrets.token_urlsafe(32)")],
  ["admin_jwt_secret given a hardcoded non-empty default (looks configured, is public)", "config", s =>
    s.replace('    admin_jwt_secret: str = ""',
      '    admin_jwt_secret: str = "changeme-but-long-enough-to-pass-32ch"')],
  ["admin_password default no longer the empty SecretStr", "config", s =>
    s.replace('    admin_password: SecretStr = SecretStr("")',
      '    admin_password: SecretStr = SecretStr("admin")')],
  ["admin_jwt_secret setting removed entirely", "config", s =>
    s.replace('    admin_jwt_secret: str = ""\n', "")],
  ["admin_password setting removed entirely", "config", s =>
    s.replace('    admin_password: SecretStr = SecretStr("")\n', "")],

  // ---- the fail-fast validator is neutralised ----------------------------
  ["@model_validator commented out (decorator text still present)", "config", s =>
    s.replace('    @model_validator(mode="after")',
      '    # @model_validator(mode="after")')],
  ["validator renamed, decorator left dangling on it", "config", s =>
    s.replace("def require_admin_credentials(self)", "def _disabled_require_admin_credentials(self)")],
  ["decorator detached from the validator (blank line + unrelated method between)", "config", s =>
    s.replace(VALIDATOR_HEAD,
      '    @model_validator(mode="after")\n    def _unrelated(self) -> "Settings":\n        return self\n\n    def require_admin_credentials(self) -> "Settings":\n')],
  ["validator short-circuits with an unconditional `return self`", "config", s =>
    s.replace(VALIDATOR_HEAD, VALIDATOR_HEAD + "        return self\n")],
  ["production gate inverted to always-skip (`environment != \"production\"` -> `is not None`)", "config", s =>
    s.replace('        if self.environment != "production":', "        if self.environment is not None:")],
  ["production gate deleted (validator no longer scoped, and no raise path left)", "config", s =>
    s.replace('        if self.environment != "production":\n            return self\n', "")
      .replace(/        if missing:\n            raise ValueError\(\n[^)]*\)\n/, "")],

  // ---- individual required vars quietly dropped --------------------------
  ["ADMIN_PASSWORD no longer appended to missing (name survives in other text)", "config", s =>
    s.replace('        if not self.admin_password.get_secret_value():\n            missing.append("ADMIN_PASSWORD")\n',
      '        if not self.admin_password.get_secret_value():\n            pass  # ADMIN_PASSWORD\n')],
  ["ADMIN_JWT_SECRET no longer appended to missing", "config", s =>
    s.replace('        if not self.admin_jwt_secret:\n            missing.append("ADMIN_JWT_SECRET")\n',
      '        if not self.admin_jwt_secret:\n            pass  # ADMIN_JWT_SECRET\n')],
  ["the `raise ValueError` downgraded to a log line (missing list computed, never enforced)", "config", s =>
    s.replace(/        if missing:\n            raise ValueError\(\n([\s\S]*?)\n            \)\n/,
      "        if missing:\n            pass\n")],
  ["MIN_ADMIN_JWT_SECRET_LENGTH constant removed (no minimum strength)", "config", s =>
    s.replace(/^MIN_ADMIN_JWT_SECRET_LENGTH = \d+$/m, "")
      .replace(/        if len\(self\.admin_jwt_secret\) < MIN_ADMIN_JWT_SECRET_LENGTH:\n            raise ValueError\(\n[\s\S]*?\n            \)\n/, "")],

  // ---- the deployment contract -------------------------------------------
  ["ADMIN_JWT_SECRET dropped from .env.example", "env", s =>
    s.replace(/^ADMIN_JWT_SECRET=.*$/m, "")],
  ["ADMIN_PASSWORD dropped from .env.example", "env", s =>
    s.replace(/^ADMIN_PASSWORD=.*$/m, "")],
  ["'Required in production' note removed from .env.example", "env", s =>
    s.replace(/Required in production/g, "Optional")],
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
const MIN_MUTANTS_EXECUTED = 18;
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
