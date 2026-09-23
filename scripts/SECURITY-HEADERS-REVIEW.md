# Security response headers — adversarial re-review + test hardening (BAS-213 follow-up)

Reviewer: Security Engineer (435e7e6d)
Date: 2026-09-23

## Context

A parallel run landed `security_headers.py` + `scripts/check-security-headers.mjs` in all three
voice services (voice-phone `70c6c8b`, voice-telegram `78b4fff`, voice-web `6ed66b5`, plus the
follow-ups that fixed the voice-web wiring bug). Rather than duplicate that work I converged on
their commits and did an independent adversarial review of what shipped.

## Independent verification of the landed state

- `node scripts/check-security-headers.mjs` → exit 0 in all three repos.
- `node scripts/check-admin-config.mjs` → exit 0 in all three (no regression from the headers work).
- `node scripts/check-admin-xss.mjs` → exit 0 in voice-phone and voice-web.
- `pytest tests/test_security_headers.py` → 4 passed per repo (pre-change).
- Live runtime coverage probe against voice-web with `public_base_url=https://…`, asserting the
  headers reach **every response class**, not just the happy path:

  | path | status | CSP | HSTS |
  |---|---|---|---|
  | `/` | 200 | yes | yes |
  | `/api/voice-web/health` | 200 | yes | yes |
  | `/api/voice-web/me` | 401 | yes | yes |
  | `/nope` (Starlette 404) | 404 | yes | yes |
  | `/api/voice-web/services/voice/calls` | 401 | yes | yes |

## Mutation audit of the landed guard (6 independent mutants)

| # | Mutation | static guard | runtime tests |
|---|---|---|---|
| A | `install_security_headers(...)` call deleted from `main.py` (module present, never attached) | caught | caught |
| B | HSTS made unconditional (`if True`) | caught | caught |
| C | `Referrer-Policy` weakened to `unsafe-url` | caught | caught |
| D | `data:` added to `script-src` | caught | **ESCAPED** |
| E | `form-action 'self'` directive deleted | caught | caught |
| F | `X-Content-Type-Options` deleted | caught | caught |

Baseline (unmutated) passes both layers, so the audit is non-vacuous. Mutant A is the important
one — a CSP module that is never wired into `create_app` ships zero headers, and that is the exact
bug that had already occurred once in voice-web (`110a94f`).

## Gaps found and fixed

Commits `2d6ffd4` (voice-phone), `a263d83` (voice-telegram), `55a305c` (voice-web) —
`tests/test_security_headers.py`:

1. **`script-src` was under-asserted.** The tests only checked that `cdn.jsdelivr.net` was absent
   from `script-src`. Mutant D (`data:`) and a variant adding `'unsafe-eval'` both passed. The
   directive is now pinned exactly to `'self' 'unsafe-inline'`, and the whole CSP string is
   asserted free of wildcards and `unsafe-eval`. `'unsafe-inline'` remains the single, recorded
   loosening required by the inline-HTML dashboards.
2. **Only routed responses were covered.** A middleware variant that returned early for
   `status_code >= 400` passed every test. Starlette generates 404s below the route handlers and
   they are attacker-triggerable, so each repo now has an explicit
   `test_headers_cover_unmatched_routes` case.

### Re-run after the fix

| mutant | runtime tests |
|---|---|
| `script-src` + `data:` | caught |
| `script-src` + jsDelivr CDN | caught |
| `script-src` + `'unsafe-eval'` | caught |
| middleware skips `status >= 400` | caught |

Baseline green: **5 passed** in each of voice-phone, voice-telegram, voice-web. All three
`check-security-headers.mjs` and `check-admin-config.mjs` still exit 0. CI workflows were left
exactly as the parallel run committed them (my duplicate guard step was reverted, not layered on).

## Residual risk / recorded limitation

`script-src 'unsafe-inline'` is still required because all three dashboards are single-file inline
HTML with inline event handlers. Removing it means extracting the scripts to static files and
either hashing or noncing them — worth doing, but it is a refactor, not a header change. Until
then the compensating controls are the escaping (`check-admin-xss.mjs`) plus the directives that
close the *exfiltration* channels (`connect-src`/`img-src`/`media-src 'self'`), which is where the
call audio and transcripts actually live.

## Remaining

All commits are local to the agent runner; remote push is blocked by the unauthorised runner SSH
key tracked in **BAS-216**. Ahead of `origin/main`: voice-phone 8, voice-telegram 8, voice-web 9.
