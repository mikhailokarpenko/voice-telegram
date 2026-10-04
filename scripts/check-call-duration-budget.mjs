#!/usr/bin/env node
// Guard: the configured per-call duration budget must actually be enforced.
//
// Why this exists (BAS-230):
//   `max_call_seconds` has existed in this service since the beginning as an
//   env setting (config.py), a column on agent_configs (admin/models.py), a
//   validated admin API field (admin/routes.py, ge=60 le=7200) and a slider in
//   the voice-web dashboard. Nothing read it. The Telegram userbot answered a
//   call and ran it until one of the two parties hung up -- and if neither did
//   (silent caller, a wedged pytgcalls stream, a provider socket that answers
//   pings forever) the call ran until the process restarted:
//     * the realtime provider is billed per minute for the whole time;
//     * this client tracks exactly one `_active_user_id`, so the stuck call
//       holds the only call slot and every later caller gets nothing;
//     * the DB row stays "in-progress" forever and never gets its transcript.
//   voice-phone enforces the same budget with `asyncio.timeout(max_seconds)`
//   around its media bridge. This client is event-driven (pytgcalls callbacks)
//   with no such scope, so the budget is a watchdog task that forces the normal
//   hangup path.
//
//   An operator who sets MAX_CALL_SECONDS, or an admin who drags the duration
//   slider, is entitled to believe the ceiling binds. A knob that is read by
//   the API and ignored by the runtime is worse than no knob: it reports a
//   limit that does not exist. That is what this guard pins.
//
// The guard is static (node-only, no Python/deps) so it runs in the `guards`
// CI job on every push.
//
// Run: node scripts/check-call-duration-budget.mjs   (exit 0 = safe)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLIENT = "src/voice_telegram/telegram/client.py";
const CONFIG = "src/voice_telegram/config.py";

const failures = [];
const fail = (msg) => failures.push(msg);

const read = (rel) => {
  const p = join(repoRoot, rel);
  if (!existsSync(p)) {
    fail(`${rel} not found; guard must run from the repo root`);
    return null;
  }
  return readFileSync(p, "utf8");
};

const client = read(CLIENT);
const config = read(CONFIG);

// ---------------------------------------------------------------------------
// 1. The setting must still exist and be a positive integer by default.
//    (If someone "fixes" an enforcement failure by deleting the knob, that is a
//    different decision and must not pass silently as an unbounded default.)
// ---------------------------------------------------------------------------
if (config) {
  const line = config.match(/^\s*max_call_seconds\s*:\s*int\s*=\s*(\d+)\s*$/m);
  if (!line) {
    fail(`${CONFIG}: max_call_seconds: int = <positive default> setting not found`);
  } else if (Number(line[1]) <= 0) {
    fail(`${CONFIG}: max_call_seconds default must be > 0 (found ${line[1]}; 0 disables the budget for every deployment that does not set it)`);
  }
}

// Strip comments before asserting on the client: every claim below must be
// satisfied by live code. A commented-out watchdog is exactly the regression
// this guard exists to catch, and substring checks are happy to read prose.
const live = (src) =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

if (client) {
  const code = live(client);

  // -------------------------------------------------------------------------
  // 2. The budget must be read, and read from BOTH sources of truth: the
  //    active agent_configs row when there is one, the env setting otherwise.
  //    Reading only settings.* means the admin slider is still decorative.
  // -------------------------------------------------------------------------
  if (!/\bmax_call_seconds\b/.test(code)) {
    fail(`${CLIENT}: never reads max_call_seconds — the configured per-call duration budget is not enforced anywhere in the Telegram client`);
  }
  if (!/active_config\.max_call_seconds/.test(code)) {
    fail(`${CLIENT}: must use active_config.max_call_seconds when an agent config row is active (otherwise the admin API's duration field is decorative)`);
  }
  if (!/self\.settings\.max_call_seconds/.test(code)) {
    fail(`${CLIENT}: must fall back to self.settings.max_call_seconds when no agent config row is active`);
  }

  // -------------------------------------------------------------------------
  // 3. The budget must be armed on the answer path, not merely computed.
  //    A local variable that is never passed to a waiter enforces nothing.
  // -------------------------------------------------------------------------
  const enforcer = code.match(
    /^[ \t]*async def (_enforce_max_call_seconds)\s*\([^)]*\)[^\n]*:\n([\s\S]*?)(?=\n[ \t]*(?:async def |def |@|# ---)|$(?![\s\S]))/m,
  );
  if (!enforcer) {
    fail(`${CLIENT}: async def _enforce_max_call_seconds(...) must exist as live code (the duration watchdog)`);
  } else {
    const body = enforcer[2];
    // It must actually wait for the budget...
    if (!/await asyncio\.sleep\(\s*max_seconds\s*\)/.test(body)) {
      fail(`${CLIENT}: _enforce_max_call_seconds must await asyncio.sleep(max_seconds) — a watchdog that does not wait for the budget either never fires or fires immediately`);
    }
    // ...and then actually end the call. Logging a warning is not a hangup:
    // that mutant leaves the call running and the slot held, with a reassuring
    // line in the log saying the limit was hit.
    if (!/await self\.pytgcalls\.leave_call\(/.test(body)) {
      fail(`${CLIENT}: _enforce_max_call_seconds must call await self.pytgcalls.leave_call(...) — logging the timeout without hanging up leaves the call billing and the single call slot held`);
    }
    if (!/await self\._teardown_call\(\)/.test(body)) {
      fail(`${CLIENT}: _enforce_max_call_seconds must await self._teardown_call() so the transcript is saved, the call row leaves "in-progress", and the provider bridge closes`);
    }
    // A `return` before the sleep (e.g. an early-out that always triggers)
    // silently disables the watchdog. Only the documented max_seconds <= 0
    // opt-out and the cancellation path may return early.
    const beforeSleep = body.split(/await asyncio\.sleep\(/)[0] ?? "";
    const earlyReturns = beforeSleep.match(/^[ \t]*return\b/gm) ?? [];
    if (earlyReturns.length > 1) {
      fail(`${CLIENT}: _enforce_max_call_seconds has ${earlyReturns.length} early returns before the sleep; only the documented max_seconds <= 0 opt-out is allowed (an unconditional early return disables the budget while every other assertion here still passes)`);
    }
    if (!/if max_seconds <= 0:/.test(body)) {
      fail(`${CLIENT}: _enforce_max_call_seconds must handle max_seconds <= 0 explicitly (asyncio.sleep of a negative budget returns immediately and would hang up every call at once)`);
    }
  }

  // The watchdog must be started on the answer path.
  if (!/asyncio\.create_task\(\s*self\._enforce_max_call_seconds\(/.test(code)) {
    fail(`${CLIENT}: the duration watchdog is defined but never started — _answer_call must asyncio.create_task(self._enforce_max_call_seconds(max_seconds))`);
  } else {
    const answer = code.match(
      /^[ \t]*async def _answer_call\s*\([^)]*\)[^\n]*:\n([\s\S]*?)(?=\n[ \t]*(?:async def |def |@|# ---)|$(?![\s\S]))/m,
    );
    if (!answer || !/asyncio\.create_task\(\s*self\._enforce_max_call_seconds\(/.test(answer[1])) {
      fail(`${CLIENT}: the watchdog must be started from _answer_call (started from anywhere else, a call that is answered is not covered)`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Teardown must cancel the watchdog, and must not cancel itself.
  //    Without the cancel, a normal 30s call leaves a task that fires 30
  //    minutes later and tears down whatever unrelated call is live then.
  //    Without the self-check, the watchdog's own teardown cancels the task it
  //    is running in and the hangup never completes.
  // -------------------------------------------------------------------------
  const teardown = code.match(
    /^[ \t]*async def _teardown_call\s*\([^)]*\)[^\n]*:\n([\s\S]*?)(?=\n[ \t]*(?:async def |def |@|# ---)|$(?![\s\S]))/m,
  );
  if (!teardown) {
    fail(`${CLIENT}: async def _teardown_call not found`);
  } else {
    const body = teardown[1];
    if (!/self\._max_call_task\.cancel\(\)/.test(body)) {
      fail(`${CLIENT}: _teardown_call must cancel self._max_call_task — an un-cancelled watchdog from a finished call fires later and hangs up an unrelated call`);
    }
    if (!/asyncio\.current_task\(\)/.test(body) || !/self\._max_call_task is not current/.test(body)) {
      fail(`${CLIENT}: _teardown_call must not cancel the watchdog task it is being called from (compare against asyncio.current_task()); self-cancelling aborts the hangup half-done`);
    }
  }

  if (!/self\._max_call_task\s*:\s*asyncio\.Task\[None\] \| None = None/.test(code)) {
    fail(`${CLIENT}: __init__ must declare self._max_call_task: asyncio.Task[None] | None = None`);
  }
}

if (failures.length) {
  console.error("call-duration-budget guard FAILED:\n");
  for (const f of failures) console.error("  * " + f);
  console.error(
    "\nThe per-call duration budget (max_call_seconds) is configurable via env, the\n" +
      "agent_configs row and the admin API. If it is not enforced in the Telegram\n" +
      "client, every one of those knobs reports a ceiling that does not exist, and a\n" +
      "call that neither side ends runs (and bills) forever while holding the single\n" +
      "call slot. See BAS-230 / scripts/CALL-DURATION-BUDGET-AUDIT.md.",
  );
  process.exit(1);
}

console.log("call-duration-budget guard OK: max_call_seconds is read from config+DB, armed on the answer path, hangs the call up, and is cancelled on teardown.");
