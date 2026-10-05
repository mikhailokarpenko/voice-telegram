# BAS-260 — Executed behavioural tests for the per-call duration budget

**Status:** done. Unpushed (same blocked managed-GitHub-identity condition as
BAS-233/BAS-235/BAS-237).

Closes gap 3.2 of the BAS-257 test review.

## Why this existed

`src/voice_telegram/telegram/client.py` was 280 statements, 224 missed (20%) —
the largest untested surface in the voice suite. It owns
`_enforce_max_call_seconds`, the per-call duration budget added by BAS-230: a
DoS control of the same class as the voice-phone media-WS caps fixed under
BAS-226/BAS-236. Without it a call that neither side hangs up (silent caller,
wedged pytgcalls stream, a provider socket that pings forever) runs until the
process restarts — billing realtime minutes the whole time and holding this
service's single call slot so every later caller gets nothing.

`scripts/check-call-duration-budget.mjs` greps for the control statically.
Nothing executed it. **Deleting the asyncio timer kept every test green.** A
grep guard also cannot distinguish a watchdog that fires at the configured
budget from one that fires at half of it, at 60× it, or that sleeps correctly
and then does nothing useful.

## The tests

`tests/test_call_duration_budget.py`, 13 cases, all executed.

Time is virtual. A `FakeClock` replaces `asyncio.sleep` inside the client
module: each sleep registers a deadline and parks, and `advance(n)` wakes only
sleepers whose deadline has passed. So "has not fired at budget−1s" is an
assertion about the budget, not about wall-clock timing, and the suite runs in
milliseconds with no flake surface.

**The watchdog itself**

- does **not** fire at `max_call_seconds − 1`: task still pending, no
  `leave_call`, call state intact;
- **does** fire exactly at `max_call_seconds`: `leave_call(user_id)` awaited
  once with the right user, and `_active_user_id` cleared — proving the hangup
  goes through the normal teardown path, not a bare `leave_call` that would
  leak the call slot;
- sleeps on the *configured* value (`clock.slept == [90]` for a 90s budget),
  which kills hardcoded-budget and unit-confusion mutants;
- saves the transcript and moves the call row to `completed` — a timed-out call
  must not be left stuck `in-progress`;
- treats `0` as an explicit opt-out (no sleep, no hangup) and `-1` the same:
  `asyncio.sleep(-1)` returns at once, so without the guard a negative budget
  would hang up every call instantly;
- does not hang up a call that already ended (`_active_user_id is None`);
- still tears the call down when `leave_call` itself raises.

**Arming on the answer path and config precedence**

- `_answer_call` arms the watchdog from the env default when no agent-config
  row is active;
- an active `agent_configs` row **outranks** the env default, both shorter
  (120 vs 900) and longer (3600 vs 60) — without this the admin API's duration
  field is decorative, the exact BAS-230 failure;
- the answer path creates a *live task*, not just a computed number: the
  watchdog is observed parked on the configured budget via the fake clock;
- `_teardown_call` cancels the watchdog, so a finished call is not hung up
  later by a stale timer (advance 10 000 virtual seconds; no `leave_call`).

## Mutation audit

`scripts/test-call-duration-budget-behavioural-mutants.mjs` — **16 mutants,
16 caught, 0 escaped, 0 no-op.** Each weakens one real property of the control
in `client.py` and requires the *executed pytest suite* to go red; every file is
restored and the harness re-runs the suite green afterwards, with
`git diff --exit-code` behind it in CI.

Mutants cover: watchdog never started; watchdog commented out (prose that keeps
the static guard's substrings); admin/DB value ignored; env setting ignored;
sleep removed; hardcoded 86400s sleep; budget ×60; budget halved (fires early);
unconditional early return; `<= 0` opt-out inverted to always-true; `<= 0` guard
dropped; timeout only logs; `leave_call` removed; `_teardown_call` removed; a
failing `leave_call` aborting before teardown; teardown no longer cancelling the
watchdog.

A vacuity floor (`MIN_MUTANTS_EXECUTED = 16`, raise-only) counts mutants that
actually executed, so emptying the list or short-circuiting the loop fails
rather than reporting "0 caught, exit 0".

This is deliberately a *second* harness alongside
`scripts/test-call-duration-budget-guard-mutants.mjs` (19 mutants against the
static guard). That one proves the grep guard goes red; this one proves the
behaviour does. Its filename is intentionally outside the `test-*-guard-mutants.mjs`
glob used by the Node-only `guards` CI job, because it needs Python — it is
wired explicitly into the `tests` job instead.

## Coverage

`telegram/client.py`: **20% → 61%** (280 statements, 224 missed → 110 missed).
Suite total 73%. The remaining misses are the pyrogram/pytgcalls wiring in
`start()` and the audio pipeline, which are out of scope for this issue.

## Run

```
cd /workspace/voice-suite/voice/voice-telegram
~/toolchain/tgvenv/bin/python -m pytest -q          # 206 passed
node scripts/test-call-duration-budget-behavioural-mutants.mjs   # 16 caught, 0 escaped
node scripts/check-ci-wiring.mjs                    # 19 guard entrypoints wired
```
