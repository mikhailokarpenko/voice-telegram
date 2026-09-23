# Security response headers — guard + mutation audit (BAS-213 follow-up)

Author: Bertram Gilfoyle

## What shipped

`src/<pkg>/security_headers.py` + `install_security_headers(app, public_base_url=...)` wired into
`create_app` in all three voice services (voice-phone, voice-telegram, voice-web), covered by
`tests/test_security_headers.py` and the static guard `scripts/check-security-headers.mjs`
(runs in the node-only `guards` CI job, no Python/deps needed).

## Why headers at all — the escaping fix is one layer

BAS-213 fixed stored XSS by escaping the Twilio-controlled call fields (`From`, `To`, `CallSid`,
provider `error`) in the admin dashboards. `check-admin-xss.mjs` keeps that honest. But an escaper
is one refactor away from regressing: a new column rendered with plain concatenation and the
payload is executing in the authenticated admin origin again.

These headers cap the blast radius of that future regression:

- `connect-src 'self'`, `img-src 'self' data:`, `media-src 'self'` — an injected script cannot
  beacon transcripts or call recordings to an attacker host. This is the directive that matters
  most here; the data at risk is call audio and transcripts.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` — no clickjacking the admin controls.
- `object-src 'none'`, `base-uri 'none'` — no plugin or `<base>` hijack.
- `form-action 'self'` — no credential-posting form to an attacker endpoint.
- `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, `Permissions-Policy` denying
  camera/mic/geolocation/payment/usb.
- HSTS one year, **only** when `public_base_url` is https, so local http dev is untouched.

### Recorded limitation

The dashboards use inline `<script>`/`<style>` and inline event handlers, so `script-src`/
`style-src` must allow `'unsafe-inline'` today. That is deliberate and known. What the guard does
enforce is that this stays the *only* loosening: `'unsafe-eval'`, any wildcard source, `data:` in
`script-src`, and any remote host in `script-src` (including the pinned Pico CSS CDN, which is
trusted for `style-src`/`font-src` only) are hard failures.

## Mutation audit

Every previous heartbeat in this workstream found a guard that was green against a mutant that
removed the protection (vacuous assertions in the BAS-204 auth-surface guard, the disabled-validator
escape in `check-admin-config.mjs`). So this guard was mutation-tested before it was committed.

Each mutant was applied to the real source, the guard run, then reverted; `cmp` verified the mutant
actually changed the file first (a no-op mutant "passing" is the same trap as a vacuous assertion —
that bit me once already), and the baseline was re-checked green afterwards.

voice-phone, 13/13 caught, 0 escaped, 0 no-op mutants:

| mutant | result |
|---|---|
| `connect-src 'self'` -> `connect-src *` | caught |
| `frame-ancestors 'none'` deleted | caught |
| `object-src 'none'` -> `'self'` | caught |
| `script-src` gains `'unsafe-eval'` | caught |
| `script-src` gains the jsDelivr CDN | caught |
| `X-Frame-Options: DENY` -> `SAMEORIGIN` | caught |
| `X-Content-Type-Options: nosniff` deleted | caught |
| HSTS made unconditional (`if https:` -> `if True:`) | caught |
| `apply_security_headers` body deleted (headers computed, never written) | caught |
| `@app.middleware("http")` removed (module intact, never installed) | caught |
| `media-src 'self'` -> `media-src https: data:` | caught |
| `main.py`: `install_security_headers(...)` call removed | caught |
| `main.py`: called without `public_base_url=` (HSTS silently wrong) | caught |

voice-telegram and voice-web: the three structural mutants (`connect-src *`, apply-body no-op,
`main.py` call removed) re-run per repo, all caught, baseline green.

The two mutants that matter most are the last four in the table. A CSP module that exists, defines a
perfect policy, and is never attached to the app is exactly the shape of "looks like coverage,
covers nothing" that this workstream keeps finding. The guard asserts the wiring, not just the
constant.

## Not covered by this guard

- Runtime behaviour (actual response headers on real requests) — that is
  `tests/test_security_headers.py` in the `tests` CI job. No Python interpreter exists in the agent
  sandbox this run, so those tests were **not** executed here; they run in CI.
- Removing `'unsafe-inline'` from `script-src`, which needs the inline handlers moved out of the
  dashboard HTML first. Worth doing; it is a separate change with real regression risk.

## Addendum — concurrent-agent collision, and the two mutants that escaped

Mid-run another agent wrote its own `check-security-headers.mjs` over mine in all three repos (a
multi-repo variant with per-assertion `ok`/`FAIL` output). Its CSP-directive assertions were fine,
but it was **green against the two mutants that disable the protection completely**:

| mutant | concurrent guard | this guard |
|---|---|---|
| body of `apply_security_headers` deleted (headers computed, never written) | **ESCAPED** | caught |
| `@app.middleware("http")` registration removed (module intact, never installed) | **ESCAPED** | caught |

Both ship a service with zero security headers while every directive assertion still passes. Same
failure shape as the disabled-validator escape in `check-admin-config.mjs`: plenty of assertions
about a constant, none about whether the constant is ever *used*. The mutation-verified version was
restored and committed in all three repos.

That collision also surfaced a real bug, not just a guard quality issue: **voice-web's `create_app`
never called `install_security_headers`**. The module and its tests were in the tree; the middleware
was never attached, so voice-web served no CSP at all. Fixed in `110a94f`. This is precisely the
class of defect the wiring assertions exist to catch, and it was live in the repo — the argument for
asserting wiring over constants is not hypothetical here.

## Verification status

- All three repos: `check-security-headers.mjs`, `check-admin-config.mjs`, and (phone/web)
  `check-admin-xss.mjs` exit 0 at their current HEAD.
- `check-security-headers.mjs` skips absent siblings, so a single-repo CI checkout still passes
  (verified by copying voice-telegram alone into a scratch dir and running it).
- Python tests not run: no interpreter in this sandbox. They run in the `tests` CI job.
- All commits in all three repos are **unpushed** (see BAS-216).
