# Voice suite: the Python suites were executed, for the first time

**Date:** 2026-10-05 · **Agent:** Bertram Gilfoyle

A long run of issues carried the same caveat — *"there is no Python interpreter
in this sandbox, and an unexecuted test is the same class of evidence as an
unexecuted guard"* — and parked behavioural tests as `todo`. This run had a
working CPython, so the tests were actually run. Two of them were wrong.

## Toolchain

`/workspace/.pytools/python` — standalone CPython 3.12.15. Bootstrap:

```sh
export PATH=/workspace/.pytools/python/bin:$PATH
cd voice-phone   && pip install -e ".[dev]"
cd voice-web     && pip install -e ".[dev]"
cd voice-telegram && pip install -e ".[dev]"   # see caveat
```

**voice-telegram caveat:** `pip install -e ".[dev]"` fails outright — the
pinned `TgCrypto==1.2.5` has no wheel for 3.12 and its sdist does not build
here. TgCrypto is a *speedup only* (pyrogram prints a warning and runs without
it), so install the rest directly and skip it:

```sh
pip install numpy kurigram py-tgcalls soxr python-dotenv alembic pyjwt "sqlalchemy[asyncio]"
```

This is worth fixing in `pyproject.toml` — the pin makes a clean 3.12 install
impossible, which is a plausible reason nobody had run this suite.

## Results

| repo | result |
|---|---|
| voice-phone | **85 passed** (incl. the 22 config-enum and 2 media-flood cases) |
| voice-telegram | **184 passed** (incl. 23 config-enum and 128 opening-message) |
| voice-web | **48 passed** |

All 9 voice-telegram guard harnesses still pass; `check-upstream-client.mjs`
passes.

## Two real defects the execution found

### 1. voice-web — `request()` parsed a redirect as a body (commit `d6b3ab1`)

`test_upstream_client_does_not_follow_redirects` asserted `exc.status_code ==
302`. The actual behaviour: `follow_redirects=False` hands the 3xx back to us,
`request()` passed it to `_read_json()`, and the empty body became
`502 "voice returned a malformed response"`.

The security property was never broken — `attacker.test` is never contacted —
but the failure mode was a misleading parse error instead of an explicit
refusal. `request()` now checks `response.is_redirect` before reading, closes
the stream, and raises `502 "<service> returned an unexpected redirect"`. The
test now asserts the host is untouched *and* the refusal is explicit.

### 2. voice-telegram — three audio tests were wrong, not "environmental" (commit `6f5ad24`)

`scripts/BAS-237-OPENING-MESSAGE-BEHAVIOURAL-TESTS.md` recorded `179 passed, 3
failed` and attributed the failures to "a `soxr` build differing from the
pinned 0.5.0.post1". That diagnosis is incorrect and should be read as
superseded.

* `StreamingResampler` wraps `soxr.ResampleStream`, which carries filter
  delay. The first 20ms frame legitimately returns `b""`. Asserting an exact
  per-frame output length can never pass for *any* soxr build.
* `test_constants` asserted `OPENAI_CHUNK_BYTES == 960`, derived from a 20ms
  chunk. The shipped `OPENAI_CHUNK_MS` is **100**, so the real value is 4800.
  The test was stale against the source, not against the environment.

Rewritten to assert the steady-state ratio over 5s of audio (0.5x and 4.0x,
±1%/±5%) and to assert the constants against their derivations. Added coverage
for stereo channel duplication (a drifted interleave is audible) and for
empty-input passthrough.

## What this says about the process

Every one of these suites was *written* carefully and *reviewed* statically,
and two of them were wrong in ways no amount of reading would have caught: a
streaming filter's delay, and a constant that moved under a test. The static
guards were all correct. The gap was exclusively in the unexecuted Python.

CI already runs `pytest -q` in all three `ci.yml` files, so CI would have
caught both — the failures only survived because the authoring sandbox could
not run what CI runs. The durable fix is the bootstrap above, so no future run
has to park a behavioural test as `todo`.

## Publication

Both commits are **unpushed**, same blocked managed-GitHub-identity condition
as BAS-233 / BAS-235 / BAS-216. No new blocker.
