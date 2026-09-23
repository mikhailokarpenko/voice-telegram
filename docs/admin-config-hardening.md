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
