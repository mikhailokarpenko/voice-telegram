# CI-wiring guard — mutation audit (voice suite)

Bertram Gilfoyle. Commits: voice-phone `facbd61`, voice-telegram `b8ae2e1`, voice-web `38d3ffc`.

## The hole

Every `scripts/check-*.mjs` in the three voice repos pins a control in the product.
**Nothing pinned the guards themselves to CI.** Two live defects:

1. **`set -e` was missing from the mutation-audit loop in all three `ci.yml`.**
   `for f in scripts/test-*.mjs; do node "$f"; done` exits with the status of the
   *last* iteration. A red harness in any earlier position was swallowed and the
   step went green. Verified directly, not assumed:
   a two-iteration loop whose first command exits 1 returns `0`.
2. **Deleting a `- name: ... run: node scripts/check-foo.mjs` step was invisible.**
   The script, its harness and its `*-AUDIT.md` all stay on disk, the repo still
   looks fully guarded, and the control is never executed again. Same for a newly
   added guard nobody wired, and for `continue-on-error: true`.

## The guard

`scripts/check-ci-wiring.mjs` + `scripts/lib-workflow.mjs` (dependency-free parser
for the Actions-YAML subset these workflows use; these repos ship no YAML dep and
the guard must run as an early node-only step).

Discovery is **from the filesystem**, never from a list inside the guard, so adding
a `check-*.mjs` without wiring it is itself a failure. Asserts:

- every guard entrypoint in `scripts/` is executed by an explicit step or by a glob
  loop whose pattern really matches it;
- `set -e` on any `for ... in scripts/...` loop;
- `git diff --exit-code` after the harnesses (they rewrite real source files; an
  un-restored tree means every later guard audits the mutant);
- no `continue-on-error: true`; `push` and `pull_request` triggers;
- `actions/checkout` in **every job that runs guards/tests** (not just somewhere in
  the workflow — see the escape below);
- pytest collects every `tests/test_*.py`, with a narrowed `pytest tests/x.py`
  treated as a failure;
- every `check-*.mjs` has a mutation harness naming it.

### Harness debt is a ratchet, not an instant red

Several voice guards were mutation-audited by hand (the `*-AUDIT.md` files) without a
committed re-runnable harness. Failing hard on those would just paint CI red and get
the guard deleted. `scripts/ci-wiring-harness-debt.json` records the baseline and may
only **shrink**: a new unharnessed guard fails, and leaving a now-harnessed guard in
the file also fails, so the excuse list cannot drift in either direction.

Baselines recorded: voice-phone 4 (`admin-config`, `admin-xss`,
`media-ws-prestart-bounds`, `security-headers`); voice-telegram 2 (`admin-config`,
`security-headers`); voice-web 4 (`admin-config`, `admin-xss`,
`recording-streaming`, `security-headers`). That is the next tranche of work.

## Mutation matrix — 14 mutants, **14 caught, 0 escaped, 0 no-op**, in each of the three repos

| mutant | result |
|---|---|
| mutation-audit loop step deleted entirely | caught |
| `git diff --exit-code` removed | caught |
| `set -e` removed from the harness loop | caught |
| one explicit guard step deleted | caught |
| every explicit guard step deleted | caught |
| `continue-on-error: true` on the guards job | caught |
| `pull_request` trigger removed | caught |
| `push` trigger removed | caught |
| `actions/checkout` removed from the guards job | caught (**escaped v1**) |
| pytest narrowed to a single module | caught |
| pytest step removed | caught |
| harness-debt baseline widened | caught |
| harness-debt baseline emptied | caught |
| harness-debt baseline lists an already-harnessed guard | caught |

**The escape is the interesting one.** v1 asserted `actions/checkout` existed
*somewhere in the workflow*. Both voice workflows have a second `tests` job with its
own checkout, so deleting it from the `guards` job read green — the guards would then
run against a non-existent tree. Now asserted per-job, for every job that runs a
guard, pytest or ruff. Same defect class as every other vacuity catch in this
workstream: asserting that some text exists instead of that the control is in force.

Each mutant is verified to have actually changed the file (no-ops are reported and
never counted as caught), and the guard is re-run green on the restored tree, so a
dirty revert cannot pass.

## Collateral

All `check-*.mjs` green and all `test-*-guard-mutants.mjs` pass at HEAD in all three
repos (voice-phone 7+3, voice-telegram 4+2, voice-web 7+3). Trees clean.

## Publication

Committed, **unpushed**: this run has no managed GitHub identity
(`No managed GitHub identity is available for this run`). Same publication blocker as
BAS-228. The repos are also root-owned in this sandbox; commits required
`git -c safe.directory='*' -c user.useConfigOnly=false`.

## Next tranche (follow-up work)

The ten guards in `ci-wiring-harness-debt.json` need committed, re-runnable harnesses:

- voice-phone: `check-admin-config`, `check-admin-xss`, `check-media-ws-prestart-bounds`, `check-security-headers`
- voice-telegram: `check-admin-config`, `check-security-headers`
- voice-web: `check-admin-config`, `check-admin-xss`, `check-recording-streaming`, `check-security-headers`

Pattern to copy: `voice-phone/scripts/test-twilio-signature-guard-mutants.mjs`.
Rules: each mutant removes exactly ONE real control; no-op mutants are reported and
never counted as caught; the guard is re-run green on the restored tree. Remove the
entry from `ci-wiring-harness-debt.json` as each lands — leaving a now-harnessed guard
listed is itself a guard failure, by design.

This could not be filed as a Paperclip issue: `POST /api/issues` returned 403
`Route not allowed` on the run that produced this work (no `PAPERCLIP_TASK_ID`).
