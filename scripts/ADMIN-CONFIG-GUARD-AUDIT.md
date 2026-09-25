# voice-phone admin-config guard: mutation audit

## Guard mutation audit (2026-09-23, Gilfoyle)

The guard was passing against a mutant it should have caught. Renaming the
validator to `def _disabled_require_admin_credentials` left
`check-admin-config.mjs` green in **all three repos**: the two checks were
independent substring tests (`@model_validator(mode="after")` present
*somewhere*, `require_admin_credentials` present *somewhere*), so neither
noticed they were no longer attached to each other. A guard that cannot see a
disabled validator is decorative.

Added two assertions to all three guards:
1. `@model_validator(mode="after")` must *directly decorate*
   `def require_admin_credentials(` (adjacency, not co-presence).
2. The validator body must contain `raise ValueError` — a validator that
   computes `missing` and returns `self` fails fast nowhere.

Mutation results after the fix (each mutant applied to the real config.py, then
reverted; baseline green before and after):

| mutant | voice-phone | voice-telegram | voice-web |
|---|---|---|---|
| `admin_jwt_secret` back to `secrets.token_urlsafe(32)` | caught | caught | caught |
| validator renamed `_disabled_require_admin_credentials` | caught | caught | caught |
| `raise ValueError` -> non-raising assignment in validator | caught | caught | caught |

Method note: my first `raise`-removal mutant used a perl regex that silently
matched nothing, so the guard "passed" against an unmodified file — a vacuous
mutant, the same trap as a vacuous assertion. The table above is from a
mutation verified to have changed the file first.

Location note: `voice-phone/docs/` is root-owned on this runner (uid 0) and I
am uid 1001, so the voice-phone copy of this audit lives in
`voice-phone/scripts/ADMIN-CONFIG-GUARD-AUDIT.md` instead of appended to
`docs/admin-config-hardening.md`.

---

## Re-audit 2026-09-25 (Bertram Gilfoyle) — the commented-out decorator escaped

The BAS-214 implementation is present and correct in all three repos: `admin_jwt_secret` and
`admin_password` have no generated defaults, and `require_admin_credentials` raises in production.
The *guard*, however, was still green against a mutant that removes the protection entirely:

```python
    # @model_validator(mode="after")
    def require_admin_credentials(self) -> "Settings":
```

Pydantic never registers the validator, production boots with no admin credentials, and
`check-admin-config.mjs` exits 0 — because both `/@model_validator\(mode="after"\)/` and the
decorator+def adjacency regex are unanchored and match happily *inside a Python comment*.
Same failure mode as the earlier renamed-validator escape: the guard asserted that some text
exists, not that live code exists.

### Fix

Every decorator/def assertion is now anchored to line start with `^[ \t]*` under `/m`, plus a new
explicit "def require_admin_credentials must be live code" check, and the `raise ValueError`
assertion anchored the same way. Applied to all three per-repo variants.

### Mutation matrix — 18 mutants, 18 caught, 0 escaped, 0 no-op

| mutant | voice-phone | voice-telegram | voice-web |
|---|---|---|---|
| `raise ValueError` -> `pass` | caught | caught | caught |
| decorator commented out (**previously ESCAPED in all 3**) | caught | caught | caught |
| `secrets.token_urlsafe(32)` default restored | caught | caught | caught |
| `def require_admin_credentials` commented out | caught | caught | caught |
| validator renamed `_disabled_…` | caught | caught | caught |
| decorator detached by a blank line | caught | caught | caught |

Each mutant was `cmp`-verified to have actually modified `config.py` (a no-op mutant that "passes"
is the same trap as a vacuous assertion), and the baseline was re-checked green after each repo.
`check-admin-xss.mjs` and `check-security-headers.mjs` re-run green at HEAD in all three repos.

Sixth vacuity catch in this workstream. Python tests not run — no interpreter in this sandbox
(`.venv` is an empty shell); they run in the `tests` CI job.

Commits (unpushed, see BAS-216): voice-phone `7b79dfc`, voice-telegram `886ac8e`, voice-web `421307a`.
