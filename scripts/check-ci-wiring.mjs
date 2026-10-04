#!/usr/bin/env node
// CI wiring guard (voice suite).
//
// Every other scripts/check-*.mjs in this repo pins a control in the product.
// Nothing pinned the guards themselves to CI. The failure mode is total and
// silent: drop a `- name: ... run: node scripts/check-foo.mjs` step from
// .github/workflows/ci.yml and the script stays on disk, its mutation harness
// stays on disk, the audit markdown stays on disk, the repo looks fully
// guarded -- and the control is never executed again. Same for a new
// check-*.mjs nobody wired, for a tests/test_*.py that pytest's selection
// misses, and for `continue-on-error: true`, which turns any step into
// decoration.
//
// Discovery is from the filesystem, never from a list in this file, so adding
// a guard without wiring it is itself a failure.
//
// Run: node scripts/check-ci-wiring.mjs   (exit 0 = wired)

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow, jobCommands } from "./lib-workflow.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI = join(root, ".github", "workflows", "ci.yml");
const failures = [];

if (!existsSync(CI)) {
  console.error("CI wiring guard FAILED:\n\n  - .github/workflows/ci.yml is missing; no guard is executed by CI at all.");
  process.exit(1);
}

// Shared libraries are imported, not executed; they are covered through the
// guards that import them.
const NOT_AN_ENTRYPOINT = new Set([
  "lib-py-blocks.mjs",
  "lib-html-sinks.mjs",
  "lib-workflow.mjs",
]);

const scriptFiles = readdirSync(join(root, "scripts"))
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !NOT_AN_ENTRYPOINT.has(f))
  .sort();

if (scriptFiles.length === 0) {
  failures.push("scripts/ contains no guard entrypoints; the guard suite has been deleted.");
}

const wf = parseWorkflow(CI);
const raw = readFileSync(CI, "utf8");

// --- triggers --------------------------------------------------------------
if (!wf.on.push) {
  failures.push("ci.yml no longer runs on push.");
}
if (!("pull_request" in wf.on)) {
  failures.push("ci.yml no longer runs on pull_request; a PR could merge unguarded.");
}

const jobs = Object.values(wf.jobs);
if (jobs.length === 0) failures.push("ci.yml defines no jobs; nothing runs.");

const steps = jobs.flatMap((j) => j.steps);
const runSteps = steps.filter((s) => typeof s.run === "string");
const allRun = runSteps.map((s) => s.run).join("\n");

// A step that cannot fail the job is not a control.
if (/continue-on-error\s*:\s*true/.test(raw)) {
  failures.push("ci.yml sets continue-on-error: true; a failing guard would not fail CI.");
}

// Checkout must be present IN EVERY JOB that runs something. A sibling job
// having one proves nothing: without actions/checkout the repository is not on
// disk, every `node scripts/check-*.mjs` errors on a missing file, and whether
// that reads as red or as a skipped job is not something this guard should bet
// the enforcement layer on.
for (const job of jobs) {
  const doesWork = job.steps.some(
    (s) => typeof s.run === "string" && /(scripts\/|pytest|ruff)/.test(s.run),
  );
  if (!doesWork) continue;
  if (!job.steps.some((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout"))) {
    failures.push(
      `job "${job.id}" runs guards/tests but has no actions/checkout step; the files it checks are not on disk.`,
    );
  }
}

// --- every guard entrypoint must actually be executed ----------------------
const globPatterns = [...allRun.matchAll(/for\s+\w+\s+in\s+([^\s;]+)\s*;?\s*do/g)].map((m) => m[1]);
const globMatches = (file) =>
  globPatterns.some((pat) => {
    if (!pat.startsWith("scripts/")) return false;
    const rx = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
    return rx.test("scripts/" + file);
  });

for (const file of scriptFiles) {
  if (!allRun.includes(`scripts/${file}`) && !globMatches(file)) {
    failures.push(
      `scripts/${file} exists but ci.yml never executes it; the control it pins is unenforced.`,
    );
  }
}

// --- the harness loop must abort on the first red harness ------------------
// `for f in scripts/test-*.mjs; do node "$f"; done` exits with the status of
// the LAST iteration. Without `set -e` a failing harness in any earlier
// position is silently swallowed and the step goes green.
for (const s of runSteps) {
  if (/for\s+\w+\s+in\s+scripts\//.test(s.run) && !/(^|\n)\s*set\s+-[a-z]*e/.test(s.run)) {
    failures.push(
      `the guard loop in step "${s.name ?? "(unnamed)"}" runs without \`set -e\`; a failing harness in any ` +
        "but the last iteration would be swallowed and the step would exit 0.",
    );
  }
}

// --- the harnesses rewrite real source files -------------------------------
if (!/git diff --exit-code/.test(allRun)) {
  failures.push(
    "ci.yml no longer runs `git diff --exit-code` after the mutation harnesses; a harness that leaves a " +
      "mutated control in the tree would go unnoticed, and every later guard would be auditing the mutant.",
  );
}

// --- every check-*.mjs needs a harness that can show it red ----------------
//
// Several guards in this repo were mutation-audited by hand (see the *-AUDIT.md
// files) without a committed, re-runnable harness, so making this an immediate
// hard failure would just paint CI red and get the guard deleted. Instead it is
// a RATCHET: the set of unharnessed guards is recorded in
// scripts/ci-wiring-harness-debt.json and may only shrink. A newly added guard
// with no harness fails; closing one and not updating the file also fails, so
// the baseline cannot silently drift in either direction.
const harnesses = scriptFiles.filter((f) => /^test-.*-guard-mutants\.mjs$/.test(f));
const harnessText = new Map(
  harnesses.map((h) => [h, readFileSync(join(root, "scripts", h), "utf8")]),
);
const unharnessed = scriptFiles
  .filter((f) => f.startsWith("check-"))
  .filter((f) => !harnesses.some((h) => harnessText.get(h).includes(f)))
  .sort();

const DEBT_FILE = join(root, "scripts", "ci-wiring-harness-debt.json");
if (!existsSync(DEBT_FILE)) {
  failures.push(
    "scripts/ci-wiring-harness-debt.json is missing; without the recorded baseline an unharnessed guard " +
      "cannot be distinguished from accepted debt.",
  );
} else {
  let allowed;
  try {
    allowed = JSON.parse(readFileSync(DEBT_FILE, "utf8")).unharnessed;
  } catch (e) {
    allowed = null;
  }
  if (!Array.isArray(allowed)) {
    failures.push("scripts/ci-wiring-harness-debt.json has no `unharnessed` array.");
  } else {
    for (const f of unharnessed) {
      if (!allowed.includes(f)) {
        failures.push(
          `scripts/${f} has no mutation harness naming it and is not in the recorded debt baseline; ` +
            "nothing proves that guard can go red.",
        );
      }
    }
    // Ratchet: once a guard gets a harness, it must leave the baseline, or the
    // file stops describing reality and a later regression is excused by it.
    for (const f of allowed) {
      if (!scriptFiles.includes(f)) {
        failures.push(`ci-wiring-harness-debt.json lists scripts/${f}, which no longer exists; remove it.`);
      } else if (!unharnessed.includes(f)) {
        failures.push(
          `scripts/${f} now HAS a mutation harness but is still listed in ci-wiring-harness-debt.json; ` +
            "remove it so the baseline can only shrink.",
        );
      }
    }
  }
}
if (unharnessed.includes("check-ci-wiring.mjs")) {
  failures.push(
    "scripts/check-ci-wiring.mjs has no mutation harness naming it; this guard must be proven red too, " +
      "and it is explicitly not eligible for the debt baseline.",
  );
}

// --- the Python half -------------------------------------------------------
const testsDir = join(root, "tests");
const modules = existsSync(testsDir)
  ? readdirSync(testsDir).filter((f) => /^test_.*\.py$/.test(f)).sort()
  : [];
if (modules.length === 0) {
  failures.push("tests/ contains no test_*.py modules.");
} else if (!/(^|\n|\s)pytest\b/.test(allRun)) {
  failures.push("ci.yml never runs pytest; the Python half of these controls is unexecuted.");
} else {
  // A narrowed pytest invocation (`pytest tests/test_config.py`) silently drops
  // every other regression module. Either collect the whole suite or name all.
  const pytestCmds = allRun
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^pytest\b/.test(l));
  const collectsAll = pytestCmds.some((c) => !/(^|\s)(tests|src)[\w/.-]*\.py(\s|$)/.test(c));
  if (!collectsAll) {
    for (const m of modules) {
      if (!allRun.includes(m)) {
        failures.push(`tests/${m} exists but ci.yml's pytest invocation never selects it.`);
      }
    }
  }
}

if (failures.length) {
  console.error("CI wiring guard FAILED:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("\nSee .github/workflows/ci.yml.");
  process.exit(1);
}
console.log(
  `CI wiring guard OK: ${scriptFiles.length} guard entrypoints wired, ${modules.length} test modules collected.`,
);
