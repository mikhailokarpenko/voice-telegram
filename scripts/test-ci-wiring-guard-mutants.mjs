#!/usr/bin/env node
// Mutation audit for scripts/check-ci-wiring.mjs.
//
// This guard asserts that CI executes the other guards. If it cannot go red,
// it is the most expensive kind of decoration: it certifies the enforcement
// layer. Each mutant below removes exactly one real piece of wiring from
// .github/workflows/ci.yml (or from the harness-debt baseline) and the guard
// must FAIL on it.
//
// A mutant that does not change any file is reported NO-OP and never counted
// as caught, so a stale anchor cannot inflate the score. Every file is
// restored and the baseline is re-checked green afterwards.
//
// Run: node scripts/test-ci-wiring-guard-mutants.mjs  (exit 0 = all caught)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(root, "scripts", "check-ci-wiring.mjs");
const CI = join(root, ".github", "workflows", "ci.yml");
const SAMPLE_HARNESS = join(root, "scripts", "test-admin-config-guard-mutants.mjs");
const DEBT = join(root, "scripts", "ci-wiring-harness-debt.json");

function runGuard() {
  try {
    execFileSync(process.execPath, [GUARD], { cwd: root, stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const baseline = runGuard();
if (!baseline.ok) {
  console.error("BASELINE IS RED -- the mutation audit would be meaningless.\n" + baseline.out);
  process.exit(1);
}

// [name, file, mutate(text) -> text]
const mutants = [
  [
    "mutation-audit loop step deleted entirely",
    CI,
    (t) => t.replace(/\n      # A guard that has never[\s\S]*?git diff --exit-code\n/, "\n"),
  ],
  [
    "`git diff --exit-code` removed (mutated control could survive the run)",
    CI,
    (t) => t.replace(/\n\s*git diff --exit-code/, ""),
  ],
  [
    "`set -e` removed from the harness loop (red harness swallowed)",
    CI,
    (t) => t.replace(/\n(\s*)set -e\n/, "\n"),
  ],
  [
    "one explicit guard step deleted",
    CI,
    (t) => t.replace(/\n      - name: [^\n]*\n        run: node scripts\/check-[^\n]*\n/, "\n"),
  ],
  [
    "every explicit guard step deleted",
    CI,
    (t) => t.replace(/\n      - name: [^\n]*\n        run: node scripts\/check-[^\n]*(?=\n)/g, ""),
  ],
  [
    "continue-on-error: true on the guards job",
    CI,
    (t) => t.replace(/(  guards:\n)/, "$1    continue-on-error: true\n"),
  ],
  [
    "pull_request trigger removed",
    CI,
    (t) => t.replace(/\n  pull_request:\n/, "\n"),
  ],
  [
    "push trigger removed",
    CI,
    (t) => t.replace(/\n  push:\n    branches: \[main\]\n/, "\n"),
  ],
  [
    "actions/checkout removed from the guards job",
    CI,
    (t) => t.replace(/(  guards:[\s\S]*?)      - uses: actions\/checkout@v4\n/, "$1"),
  ],
  [
    "pytest narrowed to a single module (other regression tests dropped)",
    CI,
    (t) => t.replace(/run: pytest -q$/m, "run: pytest -q tests/test_config.py"),
  ],
  [
    "pytest step removed (Python half unexecuted)",
    CI,
    (t) => t.replace(/\n      - name: Pytest\n[\s\S]*?run: pytest[^\n]*\n/, "\n"),
  ],
  [
    "harness-debt baseline widened to excuse a future unharnessed guard",
    DEBT,
    (t) => {
      const j = JSON.parse(t);
      j.unharnessed = [...j.unharnessed, "check-ci-wiring.mjs"];
      return JSON.stringify(j, null, 2) + "\n";
    },
  ],
  [
    "harness-debt baseline emptied (accepted debt now unrecorded)",
    DEBT,
    (t) => {
      const j = JSON.parse(t);
      j.unharnessed = [];
      return JSON.stringify(j, null, 2) + "\n";
    },
    // Only meaningful while debt exists. Once the baseline is empty -- the goal
    // state -- emptying it is a no-op, and a no-op must not be counted as a
    // pass (that is the vacuity trap this whole workstream exists to catch) nor
    // fail the build for succeeding. It retires itself instead, and comes back
    // automatically the moment a new entry is accepted.
    (t) => JSON.parse(t).unharnessed.length > 0,
  ],
  [
    "harness-debt baseline lists a guard that already has a harness (stale excuse)",
    DEBT,
    (t) => {
      const j = JSON.parse(t);
      j.unharnessed = [...j.unharnessed, "check-login-throttle.mjs"];
      return JSON.stringify(j, null, 2) + "\n";
    },
  ],
  [
    "a mutation harness loses its MIN_MUTANTS_EXECUTED vacuity floor",
    SAMPLE_HARNESS,
    (t) => t.replace(/MIN_MUTANTS_EXECUTED/g, "MIN_MUTANTS_DECLARED_ELSEWHERE"),
  ],
  [
    "a harness floor survives in a comment only (no numeric declaration)",
    SAMPLE_HARNESS,
    (t) => t.replace(/const MIN_MUTANTS_EXECUTED\s*=\s*\d+;/, "// const MIN_MUTANTS_EXECUTED = 3;"),
  ],
  [
    // The floor is inert if it is declared but never compared against. The
    // first version of the ci-wiring rule missed exactly this: the identifier
    // still occurs in the failure message, so an occurrence count passed.
    "a harness floor is compared against a literal instead of the floor",
    SAMPLE_HARNESS,
    (t) => t.replace(/<\s*MIN_MUTANTS_EXECUTED\)/, "< 0)"),
  ],
  [
    "a harness can no longer exit non-zero",
    SAMPLE_HARNESS,
    (t) => t.replace(/process\.exit\(1\)/g, "process.exitCode = 0"),
  ],
];

let caught = 0;
let escaped = 0;
let noop = 0;

for (const [name, file, mutate, appliesWhen] of mutants) {
  const original = readFileSync(file, "utf8");
  if (appliesWhen && !appliesWhen(original)) {
    console.log(`  n/a     ${name}  (precondition no longer holds; mutant retired, not counted)`);
    continue;
  }
  let mutated;
  try {
    mutated = mutate(original);
  } catch (e) {
    mutated = original;
  }
  if (mutated === original) {
    console.log(`  NO-OP   ${name}  (mutation anchored on text that is not present; not counted)`);
    noop += 1;
    continue;
  }
  writeFileSync(file, mutated);
  let res;
  try {
    res = runGuard();
  } finally {
    writeFileSync(file, original);
  }
  if (res.ok) {
    console.log(`  ESCAPED ${name}`);
    escaped += 1;
  } else {
    console.log(`  caught  ${name}`);
    caught += 1;
  }
}

const after = runGuard();
if (!after.ok) {
  console.error("\nTree not restored cleanly -- guard is red after the audit:\n" + after.out);
  process.exit(1);
}


// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied -- or filtered to nothing by a stale
// anchor -- reports "0/0 caught" and exits 0: green while proving nothing.
// That is the same "asserted nothing" defect the guards themselves exist to
// catch, one level up. The floor counts mutants that ACTUALLY EXECUTED, so
// neither deleting entries nor short-circuiting the loop can slip past it.
// It may only be raised. Lowering it is a deliberate reduction in coverage.
const MIN_MUTANTS_EXECUTED = 17;
if ((caught + escaped + noop) < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${caught + escaped + noop} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required. ` +
      "Mutants were removed or skipped; this audit understates the guard's blind spots.",
  );
  process.exit(1);
}
console.log(
  `\nci-wiring guard mutation audit: ${caught} caught, ${escaped} escaped, ${noop} no-op ` +
    `(of ${mutants.length} mutants)`,
);
if (escaped || noop) process.exit(1);
