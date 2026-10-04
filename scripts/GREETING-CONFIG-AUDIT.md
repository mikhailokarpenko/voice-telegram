# GREETING-CONFIG-AUDIT (BAS-234) — voice-telegram

## The defect

`greeting_style` and `custom_greeting` were configurable in four places and read
in none.

| Surface | File | State before |
|---|---|---|
| Env setting | `src/voice_telegram/config.py` | `greeting_style: str = "casual"`, `custom_greeting: str = ""` |
| DB column | `src/voice_telegram/admin/models.py` | `Mapped[str]` on `agent_configs` |
| Admin API field | `src/voice_telegram/admin/routes.py` | validated on `ConfigPayload`, echoed by `_config_response` |
| Dashboard control | voice-web `static/index.html` + `app.js` | `<select id="greeting_style">` with a `custom` option, plus a `custom_greeting` textarea that unhides when `custom` is picked |
| **Runtime** | `src/voice_telegram/telegram/client.py` | **never read either one** |

`_answer_call` built the realtime session with
`opening_message=(active_config.intro_prompt if active_config else self.settings.intro_prompt)`.
`grep -rn 'greeting_style\|custom_greeting' src/` returned the config, the model
and the admin serializer — and never the Telegram client.

So an operator who selected **custom** in the dashboard and typed the greeting
their brand requires changed a database row and nothing audible. No error, no
log line, and the admin API read the value straight back, so the dashboard
confirmed a setting that did not exist. The caller heard `intro_prompt` — which
in a default deployment is `"Ahoy! Greet the caller like a proper drunk pirate."`

This is the identical dead-config class as BAS-230 (`max_call_seconds`:
configurable in four places, enforced in none), found by the sweep that run
queued as follow-up work.

## The fix

New `build_opening_message()` in `telegram/client.py`, called from `_answer_call`
with both knobs resolved from the active `agent_configs` row falling back to env
— the same precedence as every other field on that path.

Resolution order, and why:

1. `greeting_style == "custom"` and a non-blank `custom_greeting` → the custom text.
2. non-blank `intro_prompt` → the intro prompt.
3. otherwise a synthesised greeting naming the agent/company and the style.

**Precedence deliberately differs from voice-phone.** There `intro_prompt` is
spoken over a separate Twilio `<Say>` channel, so `api/voice.py` *blanks* the
realtime opening when it is set. This client has a single audio channel, so if
`intro_prompt` were checked first the custom branch would be unreachable in a
default deployment — `intro_prompt` has a non-empty default. A naive "port the
voice-phone branch" refactor gets exactly this wrong, so the guard pins the
ordering, not just the presence of the branch.

Step 3 must never return empty: `providers/openai.py` sends the opening as a
`conversation.item.create` unconditionally, so an empty opening makes the agent
open the call with silence.

## The guard

`scripts/check-greeting-config.mjs` — static, node-only, in the `guards` CI job.
It asserts, on comment-stripped source:

* both knobs still exist on all four surfaces (removing the feature is a valid
  decision, but it must be made everywhere at once; half-removing it is how the
  config went dead);
* `build_opening_message` exists as live code with a non-trivial body;
* it reads both knobs **in its body**, not merely in its signature or docstring;
* the custom branch `return`s `custom_greeting` and is ordered before the
  `intro_prompt` branch;
* a synthesised fallback return exists;
* `_answer_call` calls the resolver and passes `active_config.X` **and**
  `self.settings.X` for both knobs;
* `opening_message` is not reassigned anywhere outside the resolver.

Guard-design notes, each from a mutant that escaped a first draft:

* Slicing the resolver with `pyBlock` and testing the **whole block** passed the
  "stub body" mutant, because the parameter names in the multi-line signature
  satisfy every `greeting_style`/`custom_greeting` substring check. The guard now
  strips the signature up to `) -> str:` and both docstring forms before testing.
* The precedence check ran against the whole block for the same reason, and the
  docstring's prose about ordering flipped its index comparison. Same fix.

## Mutation matrix

`scripts/test-greeting-config-guard-mutants.mjs`:
**22 mutants, 22 caught, 0 escaped, 0 no-op.**

Covers: the original BAS-234 bug restored verbatim; resolver deleted / commented
out / defined-but-uncalled / stubbed to a constant; custom branch reading the
field but returning `intro_prompt`; custom branch removed; the `"custom"`
sentinel renamed so the dropdown value never matches; precedence inverted;
unconditional early return; empty-string fallback (silent opening); DB value
ignored for each knob (control decorative); env fallback dropped for each knob;
the resolved opening overwritten after construction; and each of the six
config/model/API field declarations deleted.

## CI

`check-ci-wiring.mjs` flagged `check-greeting-config.mjs` as unwired before the
`ci.yml` step was added — the wiring ratchet fired unprompted, third run running.
The mutation harness is picked up automatically by the existing
`scripts/test-*-guard-mutants.mjs` glob.

## Collateral

All 8 `check-*.mjs` and all 8 `test-*.mjs` green at HEAD in voice-telegram;
harnesses restore the tree, so `git diff --exit-code` passes.

## Not done, and why

A behavioural pytest (fake pytgcalls, asserting the `conversation.item.create`
payload for each of the three branches) belongs in
`tests/test_telegram_client.py`. Not written this run: there is no Python
interpreter in this sandbox, and an unexecuted test is the same class of
evidence as an unexecuted guard. Filed as a child issue.
