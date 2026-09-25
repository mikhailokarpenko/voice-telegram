# voice-telegram admin login throttle — port + mutation audit

The throttle and its guard were ported from voice-web (see that repo's
`scripts/LOGIN-THROTTLE-GUARD-AUDIT.md` for the full 15-mutant table and the
root-cause analysis of the escapes it fixes).

**Finding:** this repo's `/api/admin/login` had *no* throttle at all — an
unlimited online guessing oracle against a single shared password, and the one
voice-web itself authenticates to. Fixed in the same commit as this guard.

Mutation audit re-run against this repo's sources: **15 mutants, 15 caught,
0 escaped, 0 no-op.** All guards green at HEAD; mutated sources restored and
`git status` verified clean.
