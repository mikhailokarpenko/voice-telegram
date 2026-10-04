## BAS-223 closed: deploy-time override could still re-bless the whole private range

**Finding, restated (the issue body was lost to the `probe pending` placeholder bug):** the per-client half of the admin login throttle keys on `request.client.host`, which uvicorn's `ProxyHeadersMiddleware` rewrites from `X-Forwarded-For` when the peer is trusted. An earlier fix moved the shipped default from `*` to loopback-only, and `scripts/check-login-throttle.mjs` enforces that in source. **But the enforcement stopped at the source constant.** `resolve_trusted_proxy_ips()` screened the `TRUSTED_PROXY_IPS` env override only for `*`, so a deployment setting `TRUSTED_PROXY_IPS=172.16.0.0/12` (the natural thing to write, and exactly the value the old code shipped) silently reopened the bypass the guard exists to prevent — every co-resident container and every SSRF pivot on the shared Docker networks becomes "the proxy" and rotates the throttle bucket per guess.

Worse, uvicorn does not expand CIDR — it string-matches the peer address — so `172.16.0.0/12` trusts *nothing* while reading as if it trusted the proxy. Either way the operator's intent is not what ships.

### Fix (all three services)
`resolve_trusted_proxy_ips()` now validates **every** entry, not just the wildcard:
- rejects any entry containing `/` (a network, not an address), with an error naming the bypass
- parses each entry via `ipaddress.ip_address()` — anything that is not an exact IP is refused
- rejects the unspecified address (`0.0.0.0` / `::`), the wildcard under another name
- normalises/joins accepted entries, so `"172.20.0.5, 172.20.0.6"` → `"172.20.0.5,172.20.0.6"`

Still fails fast at import time, so a bad deploy never serves.

Files: `voice-phone/src/voice_agent/main.py`, `voice-telegram/src/voice_telegram/main.py`, `voice-web/src/voice_web/main.py`.

### Proof it stays fixed
New regression test `test_private_range_trusted_proxy_ips_is_rejected` in each suite (`voice-phone/tests/test_admin_api.py`, `voice-telegram/tests/test_admin.py`, `voice-web/tests/test_app.py`) asserts `ValueError` for `172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`, `fd00::/8`, `0.0.0.0/0`, `0.0.0.0`, a mixed `127.0.0.1,10.0.0.0/8`, and `not-an-ip`; and asserts the exact-address and unset paths still work.

`scripts/check-login-throttle.mjs` extended in all three to require the CIDR check, the `ipaddress.ip_address` parse, the `is_unspecified` rejection, that the wildcard branch actually *raises*, and that the new test exists and still exercises each private range as a real list entry (not just a mention in prose).

### Mutation results — every guard at 100%
| service | before | after |
|---|---|---|
| voice-web | 49/51 | **57/57** |
| voice-phone | — | **59/59** |
| voice-telegram | — | **56/56** |

The two pre-existing voice-web escapes are also closed as part of this: *"resolver detects the wildcard but no longer raises"* (guard now pins the `raise` to the wildcard branch) and *"resolve_trusted_proxy_ips() deleted outright"* (the mutant's regex matched the old `return resolved` and had silently become a no-op).

Six new mutants cover the new control directly: dropping the CIDR check, dropping the IP parse, dropping the unspecified check, deleting the test, defanging its `pytest.raises`, and narrowing it away from `172.16/12`. All caught.

### Verification limits
No Python interpreter exists in this runner (`voice-phone/.venv/bin/python3` dangles at `/usr/bin/python3`), so the pytest suites could not be executed here — the Node guards and their mutation harnesses were run in full and are green. The new tests are static-checked for indentation/tabs and follow the shape of the adjacent passing tests.

### Remaining
Commits are unpushed: the runner has no managed GitHub identity (`git status` reports *"No managed GitHub identity is available for this run"*), the same blocker tracked in BAS-216 / 20e67430 and 31fcf62e. This change rides that queue; it needs no separate publish issue.
