# BAS-261 — behavioural tests for the admin session cookie flags

Gap 3.3 of the BAS-257 test review: all three services set the admin session
cookie with `httponly=True`, `samesite="strict"` and
`secure=<public_base_url is https>`, but no test asserted any of it. Dropping a
flag changed no status code and no body, so the whole suite stayed green while
the third layer of the BAS-213/BAS-217 defence stack disappeared.

## Added

    voice-phone/tests/test_admin_session_cookie.py      (admin_token)
    voice-telegram/tests/test_admin_session_cookie.py   (admin_token)
    voice-web/tests/test_admin_session_cookie.py        (voice_web_token)

Each performs a real login through TestClient and parses the raw `Set-Cookie`
header (not httpx's cookie jar, which discards the attributes), asserting:

  - HttpOnly present
  - SameSite=Strict
  - Secure absent when `public_base_url` is http  (a hardcoded Secure silently
    breaks login on a plain-http deployment: the browser never stores it)
  - Secure present when `public_base_url` is https
  - Path=/

## Mutation verification (12/12 caught)

Per service, each mutation applied to the real source, suite re-run, source
restored:

    httponly=True  -> httponly=False                     1 failed  x3 services
    samesite=strict -> samesite=lax                      1 failed  x3
    secure=<scheme> -> secure=False                      1 failed  x3
    secure=<scheme> -> secure=True  (hardcoded)          1 failed  x3

The hardcoded-True mutant is the one a "just make it always secure" patch would
introduce; it is caught by the http case, so `secure` is pinned to track the
scheme in both directions rather than merely being truthy.

## Baseline

    voice-phone     python3 -m pytest -q  -> 109 passed
    voice-telegram                        -> 193 passed
    voice-web                             -> 54 passed
    voice-phone/scripts/check-ci-wiring.mjs -> OK (25 entrypoints, 13 modules;
      picks the new module up automatically, no wiring edit needed)
    voice-phone/scripts/check-admin-session.mjs -> OK
