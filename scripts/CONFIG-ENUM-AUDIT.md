# CONFIG-ENUM AUDIT (BAS-238)

## The defect

`GET /api/admin/voices` serves `AVAILABLE_VOICES` and the voice-web dashboard
renders its Voice `<select>` from it. Greeting Style is a fixed five-option
`<select>` (`casual`, `formal`, `friendly`, `professional`, `custom`).

`PUT /api/admin/config` validated neither:

    openai_voice:   str = Field(default="ash",    max_length=32)
    greeting_style: str = Field(default="casual", max_length=32)

Length is not membership. Any client that is not that exact dashboard — curl, a
script, a stale cached bundle, a tampered DOM, a half-finished migration —
could persist `openai_voice="nope"`. The API accepted it, wrote it to
`agent_configs`, and **echoed it back in the 200 response**, so every surface
reported a voice that does not exist.

Nothing failed at save time. The failure landed on the next inbound call, when
the realtime session was opened with an unknown voice and the provider rejected
it mid-call. The operator's last signal was a success toast.

This is the third member of the same family in this suite:

| Issue | Knob | Shape |
|---|---|---|
| BAS-230 | `max_call_seconds` | configurable in four places, enforced in none |
| BAS-234 | `greeting_style` / `custom_greeting` | configurable in four places, read in none |
| BAS-238 | `openai_voice` / `greeting_style` | read by the runtime, **validated against nothing** |

BAS-238 is the nastier variant. In the first two the knob did nothing, so the
blast radius was a missing feature. Here the knob works perfectly — it faithfully
delivers a value the provider cannot use, and converts a silent save into a
dropped call.

## The fix

Both services (`voice-phone`, `voice-telegram`):

* `VOICE_IDS = frozenset(v["id"] for v in AVAILABLE_VOICES)` — **derived**, not
  hand-copied. A second literal list is a list that gets edited once and not
  twice, and the dashboard would start offering a voice the API rejects.
* `GREETING_STYLES = frozenset({casual, formal, friendly, professional, custom})`.
* `@field_validator` on each, normalising (`.strip().lower()`) then raising
  `ValueError` with the permitted set in the message, so the 422 tells the
  caller what to send.

### The split that matters

The model hierarchy was deliberately restructured:

    ConfigFields(BaseModel)      <- fields only, no validators
    ├── ConfigPayload(ConfigFields)   <- write model, validators live HERE
    └── ConfigResponse(ConfigFields)  <- read model, deliberately permissive

Previously `ConfigResponse(ConfigPayload)`. Had the validators simply been added
in place, the read model would have inherited them and `GET /config` would raise
on any `agent_configs` row persisted *before* this fix — locking the operator
out of the one screen where the bad value could be corrected. A hardening change
that bricks the remediation path is not hardening.

**Reject on the way in; surface on the way out.** The guard fails if
`ConfigResponse` ever re-inherits `ConfigPayload`.

## Guard

`scripts/check-config-enums.mjs` — static, node-only, no Python or deps, so it
runs in the `guards` CI job on every push. Identical file in both repos; it
resolves `src/voice_agent/` vs `src/voice_telegram/` itself.

It asserts, on comment- and docstring-stripped source:

1. Both allowlists exist as live code; `VOICE_IDS` is *derived from*
   `AVAILABLE_VOICES`; `GREETING_STYLES` retains at least `casual` and `custom`.
2. `ConfigPayload` carries a `@field_validator` for each field, the decorator is
   attached to a real function, and that function's body contains
   `not in <ALLOWLIST>` **and** `raise ValueError`.
3. `ConfigResponse` does **not** inherit the validators, and `ConfigPayload`
   still extends the shared field base.
4. `update_config` still binds `body: ConfigPayload`.

### Why assertion 2 is phrased as `not in VOICE_IDS` and not `VOICE_IDS`

Two mutants escaped the first draft, both the same shape: the `ValueError`
message interpolates `sorted(VOICE_IDS)`, so a bare "does the body mention the
allowlist" check stayed green against

    if normalized not in set():   # allowlist named only in the error text

i.e. a validator that reports the permitted voices in an error it will never
raise. The guard now requires the allowlist name to appear *in the membership
test itself*. This is the same vacuity class recorded in the BAS-234 audit:
prose and parameter names satisfy substring checks that the code does not.

## Mutation matrix

25 mutants per service, covering: the original bug restored verbatim; each
validator deleted/commented/reduced-to-docstring; validators that never raise;
validators that drop the membership test; validators pointed at an empty set;
each allowlist deleted, hand-copied, emptied, stripped of a load-bearing member,
or degraded to a bare string (where `in` becomes substring matching, accepting
`"as"` and `"sh"`); and the one-word wiring edits — `body: ConfigFields`,
`ConfigResponse(ConfigPayload)`, `ConfigPayload(BaseModel)`.

    voice-telegram: 25 mutants, 25 caught, 0 escaped, 0 no-op
    voice-phone:    25 mutants, 25 caught, 0 escaped, 0 no-op

`check-ci-wiring.mjs` flagged the new guard as unwired before the `ci.yml` step
was added — the wiring ratchet firing unprompted for the fourth run running.

## Collateral

All 9 `check-*.mjs` and all 9 `test-*.mjs` green at HEAD in both repos; both
trees restored clean by the harnesses.

## Not done here

No behavioural pytest: this sandbox has no Python interpreter, and an unexecuted
test is the same class of evidence as an unvalidated config field. Filed
separately alongside BAS-237.

Remaining unaudited knob surface: `recordings_path` and the recording toggles in
voice-phone.
