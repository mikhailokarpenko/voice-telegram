# BAS-237 — Executed behavioural tests for `build_opening_message`

**Status:** done. `voice-telegram` commit `e23a687` (unpushed — same blocked
managed-GitHub-identity condition as BAS-233/BAS-235/BAS-216).

Sibling of BAS-240; both were blocked on the same missing Python toolchain,
and both are unblocked by the bootstrap recorded in
`voice-phone/scripts/BAS-240-CONFIG-ENUM-BEHAVIOURAL-TESTS.md`
(standalone CPython 3.12.15 in `/workspace/.local/python`, plus
`/workspace/.local/tgvenv` for `kurigram`/`py-tgcalls`/`numpy`/`soxr`).

## Why this existed

BAS-234 fixed `greeting_style` / `custom_greeting` being configurable in four
places — env settings, `agent_configs` columns, validated admin-API fields, a
voice-web dropdown — and read in **none**. The opening was always
`intro_prompt`, so selecting "custom" in the dashboard and typing a greeting
changed a stored row and nothing else.

That fix added `build_opening_message`, a three-branch resolver. No executed
test covered any branch.

## The tests

`tests/test_opening_message.py`, 128 cases. The function is pure, so these are
direct calls — no app, no session, no stand-ins.

**Branch 1 — explicit custom greeting:** spoken verbatim; outranks
`intro_prompt` (the deliberate divergence from voice-phone, which speaks
`intro_prompt` over a separate Twilio `<Say>` channel while this client has
only one); stripped; falls through when the box is blank; and does *not* leak
into a call whose style is no longer "custom".

**Branch 2 — `intro_prompt`:** used when no custom greeting applies; stripped;
blank falls through.

**Branch 3 — styled fallback:** each of `casual` / `formal` / `friendly` /
`professional` reaches the generated text; company included only when set;
empty style defaults to `casual`.

**The invariant,** over the full 6×3×3×2 cross-product of style × custom ×
intro × company: the opening is never empty. The provider sends it
unconditionally as a conversation item, so an empty return makes the agent open
the call with silence.

## Mutation verification — 8/8 caught

| # | Mutant | Failures |
|---|--------|----------|
| M1 | custom branch removed entirely (**the BAS-234 regression**) | 3 |
| M2 | `intro_prompt` reordered above the custom greeting | 1 |
| M3 | style gate dropped — `custom_greeting` leaks into non-custom calls | 1 |
| M4 | blank-greeting check dropped (**the silent-opening case**) | 15 |
| M5 | `intro_prompt` blank check → `is not None` | 83 |
| M6 | `style` default removed | 2 |
| M7 | company always omitted | 1 |
| M8 | company always included | 1 |

Source restored and diffed clean against the backup after the sweep.

## Suite result

`179 passed, 3 failed`. The three are `test_audio.py::test_resample_48k_to_24k_mono`,
`::test_resample_24k_to_48k_stereo` and `::test_constants` — **pre-existing and
environmental**, from a `soxr` build differing from the pinned `0.5.0.post1`,
and untouched by this change. Worth its own issue if anyone intends to run that
suite in this container.

## Follow-ups

* Commit unpushed; no new blocker.
* Wire `pytest` into CI for both services — the guard harnesses are wired, the
  Python suites are not, which is how these unexecuted-test gaps opened.
