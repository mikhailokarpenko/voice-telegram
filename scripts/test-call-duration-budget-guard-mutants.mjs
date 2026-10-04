#!/usr/bin/env node
// Mutation audit harness for scripts/check-call-duration-budget.mjs.
//
// A guard that has never been shown red proves nothing. Each mutant below
// weakens one real control out of the tree -- the same way a refactor,
// a merge, or a "temporary" debug edit would -- and the guard must fail.
// Every file is restored afterwards; CI runs `git diff --exit-code` to prove
// the tree came back clean.
//
// SCOPE: only files inside THIS repo are mutated.
//
// Run: node scripts/test-call-duration-budget-guard-mutants.mjs
//      (exit 0 = guard catches every mutant)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-call-duration-budget.mjs");

const FILES = {
  client: join(root, "src/voice_telegram/telegram/client.py"),
  config: join(root, "src/voice_telegram/config.py"),
};

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

// [name, file-key, mutate]
const mutants = [
  // ---- the budget is never read at all ------------------------------------
  [
    "the watchdog is never started (budget computed, call still unbounded)",
    "client",
    (s) => s.replace(/^\s*self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)\n/m, ""),
  ],
  [
    "the whole watchdog method is deleted",
    "client",
    (s) => s.replace(/\n[ \t]*async def _enforce_max_call_seconds[\s\S]*?(?=\n    # -{10})/, "\n"),
  ],
  [
    "the watchdog is commented out (prose satisfies substring checks)",
    "client",
    (s) =>
      s.replace(
        /^(\s*)self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)$/m,
        "$1# self._max_call_task = asyncio.create_task(self._enforce_max_call_seconds(max_seconds))",
      ),
  ],
  [
    "the watchdog is started from stop() instead of the answer path",
    "client",
    (s) =>
      s
        .replace(/^\s*self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)\n/m, "")
        .replace(
          /^(\s*)async def stop\(self\) -> None:\n(\s*)"""Stop the Telegram client."""\n/m,
          '$1async def stop(self) -> None:\n$2"""Stop the Telegram client."""\n$2self._max_call_task = asyncio.create_task(self._enforce_max_call_seconds(1))\n',
        ),
  ],

  // ---- the budget is read from only one source -----------------------------
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

  // ---- the watchdog exists but does not bind -------------------------------
  [
    "the watchdog never waits (sleep removed): budget never fires",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "return"),
  ],
  [
    "the watchdog sleeps on a hardcoded value, not the configured budget",
    "client",
    (s) => s.replace(/await asyncio\.sleep\(max_seconds\)/, "await asyncio.sleep(86400)"),
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

  // ---- the watchdog fires but does not end the call ------------------------
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
    "leave_call removed: provider bridge closes but Telegram call stays up",
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

  // ---- lifecycle: stale watchdogs / self-cancellation ----------------------
  [
    "teardown no longer cancels the watchdog (stale task kills a later call)",
    "client",
    (s) =>
      s.replace(
        /\n[ \t]*current = asyncio\.current_task\(\)\n[\s\S]*?self\._max_call_task = None\n/,
        "\n",
      ),
  ],
  [
    "teardown cancels the watchdog it is running in (hangup aborts half-done)",
    "client",
    (s) =>
      s.replace(
        /if \(\n\s*self\._max_call_task\n\s*and self\._max_call_task is not current\n\s*and not self\._max_call_task\.done\(\)\n\s*\):/,
        "if self._max_call_task and not self._max_call_task.done():",
      ),
  ],
  [
    "the task handle is never stored, so nothing can ever cancel it",
    "client",
    (s) =>
      s
        .replace(/^\s*self\._max_call_task: asyncio\.Task\[None\] \| None = None\n/m, "")
        .replace(
          /self\._max_call_task = asyncio\.create_task\(self\._enforce_max_call_seconds\(max_seconds\)\)/,
          "asyncio.create_task(self._enforce_max_call_seconds(max_seconds))",
        ),
  ],

  // ---- the knob itself -----------------------------------------------------
  [
    "max_call_seconds setting deleted from config.py",
    "config",
    (s) => s.replace(/^\s*max_call_seconds: int = 1800\n/m, ""),
  ],
  [
    "max_call_seconds default changed to 0 (unbounded unless every deploy sets it)",
    "config",
    (s) => s.replace(/max_call_seconds: int = 1800/, "max_call_seconds: int = 0"),
  ],
];

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);

const restore = () => {
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, originals[k]);
};

// The guard must be green on the unmutated tree first; otherwise every mutant
// "passes" for the wrong reason and the whole run is vacuous.
if (!runGuard()) {
  console.error("FATAL: guard is already failing on the unmutated tree; mutation results would be meaningless");
  process.exit(1);
}

let caught = 0;
let escaped = 0;
let noop = 0;

for (const [name, key, mutate] of mutants) {
  const before = originals[key];
  const after = mutate(before);
  if (after === before) {
    // A mutator whose regex matched nothing is NOT evidence the guard works.
    console.error(`NO-OP  ${name}  (mutator matched nothing — fix the harness)`);
    noop++;
    continue;
  }
  writeFileSync(FILES[key], after);
  const green = runGuard();
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

// Prove the restore worked and the guard is green again, so the `guards` job's
// `git diff --exit-code` has something real behind it.
if (!runGuard()) {
  console.error("FATAL: guard not green after restore — the harness left the tree mutated");
  process.exit(1);
}

// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied -- or filtered to nothing by a stale
// anchor -- reports "0 caught" and exits 0: green while proving nothing. The
// floor counts mutants that ACTUALLY EXECUTED, so neither deleting entries nor
// short-circuiting the loop slips past it. It may only be raised.
const MIN_MUTANTS_EXECUTED = 19;
const _executed = caught + escaped + noop;
if (_executed < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${_executed} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required. ` +
      "Mutants were removed or skipped; this audit understates the guard's blind spots.",
  );
  process.exit(1);
}

console.log(`\n${caught} caught, ${escaped} escaped, ${noop} no-op, of ${mutants.length} mutants`);
if (escaped || noop) process.exit(1);
