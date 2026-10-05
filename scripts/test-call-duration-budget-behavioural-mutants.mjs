#!/usr/bin/env node
// BAS-260: mutation audit for tests/test_call_duration_budget.py.
//
// scripts/test-call-duration-budget-guard-mutants.mjs proves the *static*
// guard (check-call-duration-budget.mjs) goes red when the per-call duration
// budget is weakened. A grep guard cannot see runtime behaviour: it passes on
// a watchdog that sleeps and then does nothing useful, as long as the
// substrings are present. This harness mutates the same control and requires
// the *executed* pytest suite to go red.
//
// Each mutant weakens one real property of max_call_seconds. Every file is
// restored afterwards; CI runs `git diff --exit-code` behind that.
//
// SCOPE: only files inside THIS repo are mutated.
//
// Run: node scripts/test-call-duration-budget-behavioural-mutants.mjs
//      (exit 0 = the behavioural tests catch every mutant)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.VOICE_TELEGRAM_PYTHON || join(process.env.HOME || "", "toolchain/tgvenv/bin/python");
const TESTS = "tests/test_call_duration_budget.py";

const FILES = {
  client: join(root, "src/voice_telegram/telegram/client.py"),
};

const runTests = () => {
  try {
    execFileSync(PYTHON, ["-m", "pytest", "-q", "-p", "no:cacheprovider", TESTS], {
      stdio: "pipe",
      cwd: root,
    });
    return true;
  } catch {
    return false;
  }
};

// [name, file-key, mutate]
const mutants = [
  [
    "the watchdog is never started on the answer path (budget computed, call unbounded)",
    "client",
    (s) =>
      s.replace(
        /^\s*self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)\n/m,
        "",
      ),
  ],
  [
    "the watchdog is commented out (prose keeps the static guard's substrings)",
    "client",
    (s) =>
      s.replace(
        /^(\s*)self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)$/m,
        "$1# self._max_call_task = asyncio.create_task(self._enforce_max_call_seconds(max_seconds))",
      ),
  ],
  [
    "the admin/DB value is ignored; env default always wins (slider decorative)",
    "client",
    (s) =>
      s.replace(
        /max_seconds = \(\n\s*active_config\.max_call_seconds if active_config else self\.settings\.max_call_seconds\n\s*\)/,
        "max_seconds = self.settings.max_call_seconds",
      ),
  ],
  [
    "the env setting is ignored when no config row exists",
    "client",
    (s) =>
      s.replace(
        /active_config\.max_call_seconds if active_config else self\.settings\.max_call_seconds/,
        "active_config.max_call_seconds if active_config else 0",
      ),
  ],
  [
    "the watchdog never waits (sleep removed): budget never fires",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "return"),
  ],
  [
    "the watchdog sleeps on a hardcoded day, not the configured budget",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "await asyncio.sleep(86400)"),
  ],
  [
    "the budget is off by a factor of 60 (minutes read as seconds)",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "await asyncio.sleep(max_seconds * 60)"),
  ],
  [
    "the watchdog fires early (budget halved)",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "await asyncio.sleep(max_seconds / 2)"),
  ],
  [
    "the watchdog returns unconditionally before sleeping (silently disabled)",
    "client",
    (s) => s.replace(/(\n\s*)(try:\n\s*await asyncio\.sleep\(max_seconds\))/, "$1return$1$2"),
  ],
  [
    "the <= 0 opt-out becomes an always-true early return",
    "client",
    (s) => s.replace(/if max_seconds <= 0:/, "if max_seconds >= 0:"),
  ],
  [
    "the <= 0 guard is dropped (a 0/negative budget hangs up every call instantly)",
    "client",
    (s) => s.replace(/^\s*if max_seconds <= 0:\n\s*return\n/m, ""),
  ],
  [
    "timeout only logs a warning; the call keeps running and billing",
    "client",
    (s) =>
      s.replace(
        /if self\.pytgcalls:\n\s*try:\n\s*await self\.pytgcalls\.leave_call\(user_id\)\n\s*except Exception:\n\s*log\.exception\("Error leaving call after duration budget"\)\n\s*await self\._teardown_call\(\)/,
        "return",
      ),
  ],
  [
    "leave_call removed: provider bridge closes but the Telegram call stays up",
    "client",
    (s) => s.replace(/await self\.pytgcalls\.leave_call\(user_id\)/, "pass"),
  ],
  [
    "teardown removed: transcript lost, call row stuck 'in-progress', bridge leaked",
    "client",
    (s) =>
      s.replace(
        /log\.exception\("Error leaving call after duration budget"\)\n(\s*)await self\._teardown_call\(\)/,
        'log.exception("Error leaving call after duration budget")\n$1return',
      ),
  ],
  [
    "a failing leave_call aborts the watchdog before teardown (call row stuck)",
    "client",
    (s) =>
      s.replace(
        /try:\n(\s*)await self\.pytgcalls\.leave_call\(user_id\)\n\s*except Exception:\n\s*log\.exception\("Error leaving call after duration budget"\)/,
        "await self.pytgcalls.leave_call(user_id)",
      ),
  ],
  [
    "teardown no longer cancels the watchdog (stale task kills a later call)",
    "client",
    (s) =>
      s.replace(
        /\n[ \t]*current = asyncio\.current_task\(\)\n[\s\S]*?self\._max_call_task = None\n/,
        "\n",
      ),
  ],
];

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);

const restore = () => {
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, originals[k]);
};

// The suite must be green on the unmutated tree first; otherwise every mutant
// "fails" for the wrong reason and the whole run is vacuous.
if (!runTests()) {
  console.error(
    "FATAL: tests/test_call_duration_budget.py is already failing on the unmutated tree; mutation results would be meaningless",
  );
  process.exit(1);
}

let caught = 0;
let escaped = 0;
let noop = 0;

for (const [name, key, mutate] of mutants) {
  const before = originals[key];
  const after = mutate(before);
  if (after === before) {
    console.error(`NO-OP  ${name}  (mutator matched nothing — fix the harness)`);
    noop++;
    continue;
  }
  writeFileSync(FILES[key], after);
  const green = runTests();
  restore();
  if (green) {
    console.error(`ESCAPED ${name}`);
    escaped++;
  } else {
    console.log(`caught  ${name}`);
    caught++;
  }
}

restore();

if (!runTests()) {
  console.error("FATAL: suite not green after restore — the harness left the tree mutated");
  process.exit(1);
}

// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied reports "0 caught" and exits 0: green
// while proving nothing. The floor counts mutants that ACTUALLY EXECUTED.
// It may only be raised.
const MIN_MUTANTS_EXECUTED = 16;
const executed = caught + escaped + noop;
if (executed < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${executed} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required.`,
  );
  process.exit(1);
}

console.log(`\n${caught} caught, ${escaped} escaped, ${noop} no-op, of ${mutants.length} mutants`);
if (escaped || noop) process.exit(1);
