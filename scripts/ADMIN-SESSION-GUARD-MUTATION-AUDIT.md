# Admin session guard — mutation audit

`scripts/check-admin-session.mjs`, added with `scripts/test-admin-session-guard-mutants.mjs`.

## The gap it closes

The voice suite already guarded the admin **front door**:
`check-admin-config` (no generated default secrets; production fails fast) and
`check-login-throttle` (the single shared password is not an unlimited online oracle).

Nothing guarded what happens **after** login — the signed cookie every subsequent
request is authorised by, and the dependency that checks it. Each of the following
removes admin authentication entirely and was green against every pre-existing guard,
lint rule and type check in the repo:

1. `jwt.decode(..., options={"verify_signature": False})` — admin tokens mintable in a
   text editor, no secret required.
2. `algorithms=["HS256", "none"]`, or an algorithm list read from the token's own
   (attacker-controlled) header — classic alg-confusion forgery.
3. `except jwt.PyJWTError: return {}` — an invalid or expired token becomes a valid
   session. Fails **open**.
4. `httponly=True` dropped from `set_cookie` — any XSS in the dashboard (the thing
   `check-admin-xss` pins) upgrades from defacement to full session theft.
5. `Depends(require_admin)` dropped from a single handler — that one endpoint
   (transcripts, recordings, config write, the upstream `/api/admin` proxy) becomes
   unauthenticated, and nothing in the repo notices.
6. A **newly added** route that simply forgets the dependency.

## Design

- Routes are **discovered from the source file**, never from a list inside the guard, so
  case 6 is a failure by construction. The intentionally-public set (`login`, `logout`,
  and in voice-web the static index and the health probe) is an explicit allow-list, and
  the guard also fails if that set and the router diverge in the other direction.
- Every assertion runs against a block extracted by `pyBlock()` whose existence is
  asserted first. A renamed or deleted block is a FAILURE, never a vacuous pass — the
  recurring guard defect in this workstream's audit history.
- Comments are stripped before matching, so a deletion cannot be shadowed by a comment
  that still mentions the control.
- A floor is asserted on the number of discovered routes, so a broken decorator scan
  fails loudly instead of silently blessing zero routes.

A real instance of that last risk was caught during development: the first decorator
scan was single-line and silently skipped voice-web's multi-line
`@app.api_route("/api/voice-web/services/{service}/{path:path}", methods=[...])` — the
upstream proxy, the single most sensitive route in that app. The scan now consumes the
decorator until its parentheses balance and expands a `methods=` list into one key per
method. Discovery went 7 -> 8 routes.

## Results

| repo | mutants | caught | escaped | no-op |
|---|---|---|---|---|
| voice-phone | 31 | 31 | 0 | 0 |
| voice-telegram | 31 | 31 | 0 | 0 |
| voice-web | 32 | 32 | 0 | 0 |

A mutant whose regex matches nothing is reported **NO-OP** and never counted as caught;
a stale mutant inflating the score is the same trap as a vacuous assertion. Each harness
asserts the guard is green on the unmutated tree first, and green again on the restored
tree, so an always-failing guard cannot fake a pass and the `guards` job's
`git diff --exit-code` proves a clean revert.

## CI

Wired into the `guards` job of each repo's `ci.yml`. Verified non-vacuously: deleting the
step makes `check-ci-wiring.mjs` fail with
`scripts/check-admin-session.mjs exists but ci.yml never executes it`. The harness is
picked up automatically by the existing `scripts/test-*-guard-mutants.mjs` glob.

Python tests were not run — there is no usable interpreter in this sandbox; they run in
the `tests` CI job.
