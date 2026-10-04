# Mutation audit — `scripts/check-login-throttle.mjs` (voice-telegram)

Date: 2026-10-04 · Bertram Gilfoyle

## Why

The guard is regex/block-extraction over Python source. Regexes see text, not
behaviour, so a guard proves nothing until it has been shown **red** against a
tree that has actually lost the control. `scripts/test-login-throttle-guard-mutants.mjs`
removes exactly one real control per mutant and requires the guard to fail.
A mutant that changes no file is reported NO-OP and never counted as caught, so
a stale anchor cannot silently inflate the score.

## Result

| | mutants | caught | escaped | no-op |
|---|---|---|---|---|
| baseline (guard as shipped) | 50 | 48 | 2 | 0 |
| after the fix | 50 | 50 | 0 | 0 |

## The two escapes

Both were **reachability**, not presence — the same defect class found in the
seven pont-web guards and in voice-phone's copy of this guard.

1. **`check()` never locks out (condition ANDed with `False`).** The whole
   lockout condition wrapped in `(... ) and False`. Every substring the guard
   pins stays intact: both bucket comparisons, `raise HTTPException`,
   `HTTP_429_TOO_MANY_REQUESTS`, `Retry-After`, both `_prune` calls.
2. **`check()` short-circuits to a bare `return None` before any counting.**
   The entire body survives below the early return for the grep to find.

In both cases `record_failure()` still works, so the buckets fill perfectly and
are never consulted. The login endpoint becomes an unlimited online guessing
oracle against the one shared admin password — and the guard stays green.

## Fix

In `src/voice_telegram/admin/auth.py`'s `check()` block the guard now additionally rejects:

* constant-neutralised branches: `and False` / `or True` / `if False:` / `if True:`
* any `return` / `pass` / `raise SystemExit` **above** the lockout condition
  (the signature line is stripped first, so `-> None:` is not a false match)

## Scope note

The proxy-trust / `TRUSTED_PROXY_IPS` mutants (the BAS-221 / BAS-223 control)
were caught both before and after — that half of the guard was already sound.

## CI

`.github/workflows/ci.yml` now globs `scripts/test-*-guard-mutants.mjs`, runs
each harness, then `git diff --exit-code` to prove every mutant was reverted.
Future harnesses are picked up automatically.

## Reproduce

```
node scripts/check-login-throttle.mjs              # green
node scripts/test-login-throttle-guard-mutants.mjs # 50/50 caught
```
