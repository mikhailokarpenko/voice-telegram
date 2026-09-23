# Voice admin config hardening (issue bcdcb1af-38f8-42d7-8c01-8c0921fd4103)

Follow-up to the stored-XSS fix. Config hardening, not a fix.

## Problem
- `admin_jwt_secret: str = secrets.token_urlsafe(32)` in both
  `voice-phone/src/voice_agent/config.py` and
  `voice-telegram/src/voice_telegram/config.py` was evaluated once per process:
  every restart invalidated all admin sessions; replicas could not validate
  each other's tokens (voice-web logs in per request → intermittent 502
  "authentication failed"); and it looks configured when it is not.
- `admin_password` defaulted to `SecretStr("")`. Fails closed
  (`verify_password` refuses empty), but the service starts in a state where
  admin can never log in.

## Change
1. Both settings now default to empty (`""` / `SecretStr("")`) — no generated
   secret, in either service.
2. New `@model_validator(mode="after") require_admin_credentials` in both
   configs: when `environment == "production"`, missing `ADMIN_PASSWORD` or
   `ADMIN_JWT_SECRET` raises at Settings construction (startup), naming the
   missing env vars; `ADMIN_JWT_SECRET` must be >= 32 chars.
   Non-production keeps starting without them (dev/test ergonomics); login
   still fails closed there.
3. `.env.example` for both services documents both vars as production-required,
   with a generation command for the secret.
4. New CI guard `voice-phone/scripts/check-admin-config.mjs` (same style as
   `check-admin-xss.mjs`, Node-only): statically asserts no generated/random
   default, empty defaults, presence of the production validator and the
   `.env.example` documentation, for both services.
5. README section documenting the guard and the rationale.
6. Tests: 4 new cases per service in `tests/test_config.py`
   (no generated default; production requires both; short secret rejected;
   valid production config accepted). Existing telegram
   `test_settings_from_env` now sets the admin env vars.

## Verification (this run)
- `node voice-phone/scripts/check-admin-config.mjs` → OK (exit 0).
- Negative control: reverting `admin_jwt_secret` to `secrets.token_urlsafe(32)`
  makes the guard exit 1 with both expected findings; restored after.
- `PYTHONPATH=src pytest tests/test_config.py tests/test_admin_auth.py -q`
  in voice-phone → 11 passed.
- `PYTHONPATH=src pytest tests/test_config.py -q` in voice-telegram → 6 passed.
- `node voice-phone/scripts/check-admin-xss.mjs` → 53 assertions pass (no
  regression to the XSS guard).
- Not run: `tests/test_bridge.py`, `test_openai_provider.py`,
  `test_recording.py`, `test_security.py`, `test_admin_api.py`,
  telegram `test_admin.py` — the sandbox has no `twilio`, `websockets` or
  `audioop` module (Python 3.13 removed `audioop`); unrelated to this change.

## Operator note
Deployments must set `ADMIN_JWT_SECRET` to a stable, shared value across
replicas before rolling with `ENVIRONMENT=production`, otherwise startup now
fails fast (intended). Existing admin sessions are invalidated once on the
first deploy that pins the secret.

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
