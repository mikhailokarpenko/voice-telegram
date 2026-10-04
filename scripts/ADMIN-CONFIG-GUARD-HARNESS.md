# check-admin-config.mjs — executable mutation audit (voice-telegram)

`ADMIN-CONFIG-GUARD-AUDIT.md` records a hand-run audit. A hand-run audit proves the
guard was good on the day it was written and nothing after that; it cannot fail CI when
someone later relaxes an assertion. `scripts/test-admin-config-guard-mutants.mjs` is
that audit made executable, in the same shape as the other `test-*-guard-mutants.mjs`
harnesses in this repo.

Each mutant removes exactly one real control from `config.py` / `.env.example`; the
guard must go red for every one. The harness also:

- asserts the guard is **green on the unmutated tree first** (otherwise an
  always-failing guard would "catch" everything — the vacuity trap that bit this
  workstream repeatedly);
- reports `NO-OP` (never "caught") when a mutator's regex matched nothing, so a
  mutation that did not actually change the file cannot be scored as a catch;
- restores every file and re-runs the guard green afterwards, so the
  `git diff --exit-code` step in the `guards` CI job proves a clean revert.

Result at HEAD: **18/18 mutants caught, 0 escaped, 0 no-op.**

`check-admin-config.mjs` is removed from `scripts/ci-wiring-harness-debt.json` in the
same change; `check-ci-wiring.mjs` enforces that list as a ratchet, so it can never be
added back.

Run: `node scripts/test-admin-config-guard-mutants.mjs`
