# Call duration budget — audit (BAS-230)

## The defect

`max_call_seconds` existed in voice-telegram in four places:

| surface | file |
| --- | --- |
| env setting, default 1800 | `src/voice_telegram/config.py` |
| `agent_configs` column | `src/voice_telegram/admin/models.py`, `migrations/versions/0002_create_agent_configs.py` |
| admin API field, `ge=60 le=7200` | `src/voice_telegram/admin/routes.py` |
| "Maximum call duration" slider | voice-web `static/index.html` + `app.js` |

Nothing read it. `grep -rn max_call_seconds src/` returned only the config, the
model and the API serializer — never the Telegram client. The userbot answered a
call and ran it until one of the two parties hung up.

If neither did — a silent caller, a wedged `pytgcalls` stream, a provider
WebSocket that answers pings forever — the call ran until the process restarted:

* the realtime provider bills per minute for the entire duration;
* `TelegramVoiceClient` tracks exactly one `_active_user_id`, so the stuck call
  holds the only call slot and every subsequent caller gets nothing;
* the `telegram_calls` row stays `in-progress` forever and never receives its
  transcript, because the transcript is only saved in `_teardown_call`.

voice-phone enforces the identical budget (`async with asyncio.timeout(max_seconds)`
around `_run_bridge` in `api/voice.py`). voice-telegram is event-driven — the
call is driven by pytgcalls callbacks, not by a bridge coroutine you can scope —
so there was no place for the `asyncio.timeout` idiom and the budget was simply
never added.

A knob that the API validates and the runtime ignores is worse than no knob: it
reports a ceiling that does not exist to the operator who set it.

## The fix

`_answer_call` resolves the budget from the active `agent_configs` row, falling
back to the env setting (same precedence as every other field on that path), and
arms `_enforce_max_call_seconds` as a watchdog task. On expiry it logs, calls
`pytgcalls.leave_call`, and runs the normal `_teardown_call` path, so the
transcript is saved, the row moves to `completed`, the FIFO is unlinked and the
provider bridge is closed — the same end state as a caller hangup.

Two lifecycle hazards, both pinned by the guard:

* `_teardown_call` must **cancel** the watchdog. Without that, a 30-second call
  leaves a task that fires 30 minutes later and tears down whatever unrelated
  call is live at that moment.
* `_teardown_call` must **not** cancel the watchdog when it is being called
  *from* the watchdog. Self-cancellation aborts the hangup half-done (bridge
  closed, FIFO still open, row still `in-progress`). The teardown compares
  against `asyncio.current_task()`.

`max_seconds <= 0` is an explicit documented opt-out: `asyncio.sleep` of a
negative value returns immediately, which would hang up every call at once.

## The guard

`scripts/check-call-duration-budget.mjs`, wired into the `guards` job in
`.github/workflows/ci.yml`. Static (node-only, no Python or deps). It asserts:

1. the setting still exists in `config.py` with a positive default (deleting the
   knob is a different decision and must not pass as an unbounded default);
2. the budget is read from **both** sources — `active_config.max_call_seconds`
   and `self.settings.max_call_seconds` — so the admin slider is not decorative;
3. `_enforce_max_call_seconds` exists as live code, awaits
   `asyncio.sleep(max_seconds)`, and then both `leave_call`s and tears down;
4. it is started with `asyncio.create_task` **from `_answer_call`** specifically;
5. `_teardown_call` cancels the task and compares against `asyncio.current_task()`;
6. no extra early `return` before the sleep (an unconditional early return
   disables the watchdog while every other assertion above still passes).

Comment lines are stripped before any assertion, because a commented-out
watchdog satisfies every substring check — that is precisely the regression the
guard exists to catch.

## Mutation audit

`scripts/test-call-duration-budget-guard-mutants.mjs` — **19 mutants, 19 caught,
0 escaped, 0 no-op**. It asserts the guard is green on the unmutated tree first
(otherwise every result is vacuous), reports `NO-OP` rather than "caught" when a
mutator regex matches nothing, restores every file, and re-runs the guard green
on the restored tree so the `guards` job's `git diff --exit-code` has something
real behind it.

Mutants cover: watchdog never started / deleted / commented out / started from
the wrong method; DB value ignored; env fallback ignored; sleep removed; sleep
hardcoded instead of configured; unconditional early return; the `<= 0` opt-out
inverted or dropped; timeout logs but does not hang up; `leave_call` removed;
`_teardown_call` removed; teardown stops cancelling; teardown self-cancels; the
task handle never stored; and both ways of neutering the setting itself.

## Not covered here

The static guard pins the shape of the enforcement, not its runtime behaviour.
A behavioural pytest (fake `pytgcalls`, patched clock) belongs in
`tests/test_telegram_client.py` and is **not** included in this change: the
environment this was written in had no Python interpreter, and an unexecuted
test is the same class of evidence as an unexecuted guard. It is the next
tranche for this control.
