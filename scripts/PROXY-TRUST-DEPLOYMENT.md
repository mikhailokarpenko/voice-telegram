# Deployment note (docs/ is root-owned on this runner, so this lives in scripts/)

## Proxy trust and the admin login throttle (`TRUSTED_PROXY_IPS`)

The admin `/login` brute-force throttle buckets failures per client address.
uvicorn runs with `--proxy-headers`, so `request.client.host` is taken from
`X-Forwarded-For` **whenever the TCP peer is inside the trust list**. Any peer
inside that list can therefore choose its own throttle bucket and get a fresh
allowance for every password guess.

* `TRUSTED_PROXY_IPS` unset -> the image trusts loopback only (`127.0.0.1,::1`).
  Safe default: every proxied request then buckets under the proxy's own
  address, degrading the per-client half of the throttle to the global cap
  rather than disabling it.
* For real per-client throttling, set `TRUSTED_PROXY_IPS` to the **exact**
  address the reverse proxy connects from:

  ```bash
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' traefik
  # -> 172.20.0.5
  TRUSTED_PROXY_IPS=172.20.0.5
  ```

* Do **not** use a whole private range (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `fd00::/8`). The service shares its Docker networks with
  every other container on the host, so a broad range blesses any co-resident
  container — or an SSRF pivot landing inside it — as "the proxy" and the
  bypass returns. Measured with a `172.16.0.0/12` trust list, peer
  `172.20.0.3`: 12 guesses with rotating `X-Forwarded-For` -> 12x401, 0x429.
* `TRUSTED_PROXY_IPS=*` raises `ValueError` at import time; the container
  crash-loops instead of serving with the bypass open.

Enforced by `scripts/check-login-throttle.mjs` plus the regression tests
`test_private_range_peer_cannot_rotate_the_throttle_bucket` and
`test_wildcard_trusted_proxy_ips_is_rejected`.
