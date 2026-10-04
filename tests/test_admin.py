import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from voice_telegram.admin.auth import create_token, decode_token, verify_password
from voice_telegram.config import Settings
from voice_telegram.main import create_app


def _settings() -> Settings:
    return Settings(
        admin_password="testpass",
        admin_jwt_secret="test-secret",
        public_base_url="http://testserver",
    )


def test_admin_auth() -> None:
    settings = _settings()
    assert verify_password("testpass", settings)
    assert not verify_password("wrong", settings)
    assert decode_token(create_token(settings), settings)["sub"] == "admin"
    with pytest.raises(HTTPException):
        decode_token(jwt.encode({"sub": "admin", "exp": 0}, "test-secret"), settings)


def test_admin_login_and_page() -> None:
    client = TestClient(create_app(_settings(), start_telegram=False))
    assert client.get("/telegram").status_code == 404
    assert client.get("/admin").status_code == 404
    assert client.get("/ui").status_code == 404
    assert client.get("/api/admin/me").status_code == 401
    assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/admin/login", json={"password": "testpass"}).status_code == 200
    assert client.get("/api/admin/me").json()["user"] == "admin"
    assert any(voice["id"] == "marin" for voice in client.get("/api/admin/voices").json())


def test_login_throttles_brute_force_and_clears_on_success() -> None:
    app = create_app(_settings(), start_telegram=False)
    client = TestClient(app)
    for _ in range(5):
        assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401
    locked = client.post("/api/admin/login", json={"password": "wrong"})
    assert locked.status_code == 429
    assert locked.headers["retry-after"] == "300"
    # Locked out even with the *correct* password: the throttle runs before the
    # comparison, so a lockout is not a password-test oracle.
    assert client.post("/api/admin/login", json={"password": "testpass"}).status_code == 429

    app.state.login_throttle._failures.clear()
    app.state.login_throttle._global.clear()
    assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/admin/login", json={"password": "testpass"}).status_code == 200
    assert app.state.login_throttle._failures == {}


def test_login_throttle_window_expiry_and_global_cap() -> None:
    from datetime import UTC, datetime, timedelta

    from voice_telegram.admin.auth import LoginThrottle

    throttle = LoginThrottle(max_failures=2, window_seconds=60, global_max_failures=3)
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    throttle.record_failure("a", t0)
    throttle.record_failure("a", t0)
    with pytest.raises(HTTPException) as exc:
        throttle.check("a", t0)
    assert exc.value.status_code == 429
    # Old failures age out of the fixed window.
    throttle.check("a", t0 + timedelta(seconds=61))

    # Distributed spray across rotating client addresses still hits the global cap.
    fresh = LoginThrottle(max_failures=99, window_seconds=60, global_max_failures=3)
    for i in range(3):
        fresh.record_failure(f"host-{i}", t0)
    with pytest.raises(HTTPException):
        fresh.check("host-new", t0)


def test_spoofed_x_forwarded_for_cannot_rotate_the_throttle_bucket() -> None:
    """The deployed proxy-header trust must not let a client pick its own bucket.

    uvicorn ProxyHeadersMiddleware overwrites scope["client"] from
    X-Forwarded-For when the peer is trusted. These apps ship behind a reverse
    proxy, so proxy headers ARE honoured -- but trust must be pinned to the
    proxy addresses. With --forwarded-allow-ips=* (what the images used to ship)
    any unauthenticated caller rotates X-Forwarded-For and gets a fresh
    per-client bucket for every guess, so only the global cap remains.
    """
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    from voice_telegram.main import TRUSTED_PROXY_IPS

    client = TestClient(ProxyHeadersMiddleware(create_app(_settings(), start_telegram=False), trusted_hosts=TRUSTED_PROXY_IPS))
    codes = [
        client.post(
            "/api/admin/login",
            json={"password": "wrong"},
            headers={"X-Forwarded-For": f"203.0.113.{i}"},
        ).status_code
        for i in range(10)
    ]
    assert 429 in codes, "rotating X-Forwarded-For bypassed the per-client throttle"
    assert codes.index(429) <= 5


class _PeerAs:
    """Force the ASGI scope's client address, simulating the TCP peer IP.

    TestClient always reports 127.0.0.1 (or "testclient") as the peer, so without
    this the proxy-trust boundary cannot be exercised for a non-loopback peer.
    """

    def __init__(self, app: object, host: str) -> None:
        self.app = app
        self.host = host

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] != "lifespan":
            scope = dict(scope)
            scope["client"] = (self.host, 12345)
        return await self.app(scope, receive, send)  # type: ignore[operator]


@pytest.mark.parametrize("peer", ["172.20.0.3", "10.1.2.3", "192.168.1.7", "203.0.113.9"])
def test_private_range_peer_cannot_rotate_the_throttle_bucket(peer: str) -> None:
    """A co-resident container must not be trusted to set X-Forwarded-For.

    The first fix pinned proxy trust to loopback + the whole RFC1918/ULA space.
    But this service shares its Docker networks with every other container on
    the host, so any of them -- or an SSRF pivot that lands inside those ranges
    -- is inside 172.16.0.0/12 and rotates X-Forwarded-For freely: the
    per-client bucket stayed attacker-chosen. Measured against the pre-fix trust
    list, peer 172.20.0.3: 12 guesses with rotating XFF -> 12x401, 0x429.

    The shipped default is loopback-only; deployments name the real proxy via
    the TRUSTED_PROXY_IPS env var.
    """
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    from voice_telegram.main import TRUSTED_PROXY_IPS

    app = ProxyHeadersMiddleware(create_app(_settings(), start_telegram=False), trusted_hosts=TRUSTED_PROXY_IPS)
    client = TestClient(_PeerAs(app, peer))
    codes = [
        client.post(
            "/api/admin/login",
            json={"password": "wrong"},
            headers={"X-Forwarded-For": f"203.0.113.{i}"},
        ).status_code
        for i in range(12)
    ]
    assert 429 in codes, (
        f"peer {peer} rotated X-Forwarded-For past the per-client throttle "
        f"(trust list {TRUSTED_PROXY_IPS})"
    )


def test_wildcard_trusted_proxy_ips_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """TRUSTED_PROXY_IPS=* at deploy time must fail fast, not silently reopen the bypass."""
    from voice_telegram.main import TRUSTED_PROXY_IPS, resolve_trusted_proxy_ips

    monkeypatch.setenv("TRUSTED_PROXY_IPS", "*")
    with pytest.raises(ValueError):
        resolve_trusted_proxy_ips()
    monkeypatch.setenv("TRUSTED_PROXY_IPS", "172.20.0.5")
    assert resolve_trusted_proxy_ips() == "172.20.0.5"
    monkeypatch.delenv("TRUSTED_PROXY_IPS")
    assert resolve_trusted_proxy_ips() == TRUSTED_PROXY_IPS


def test_private_range_trusted_proxy_ips_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A CIDR / whole-private-range TRUSTED_PROXY_IPS must fail fast too.

    The source default is loopback-only and guarded, but the env override was
    only screened for "*". Setting TRUSTED_PROXY_IPS=172.16.0.0/12 at deploy
    time re-blessed every co-resident container to rotate the login throttle's
    bucket key -- the exact bypass BAS-223 reported.
    """
    from voice_telegram.main import TRUSTED_PROXY_IPS, resolve_trusted_proxy_ips

    for bad in (
        "172.16.0.0/12",
        "10.0.0.0/8",
        "192.168.0.0/16",
        "fd00::/8",
        "0.0.0.0/0",
        "0.0.0.0",
        "127.0.0.1,10.0.0.0/8",
        "not-an-ip",
    ):
        monkeypatch.setenv("TRUSTED_PROXY_IPS", bad)
        with pytest.raises(ValueError):
            resolve_trusted_proxy_ips()

    monkeypatch.setenv("TRUSTED_PROXY_IPS", "172.20.0.5, 172.20.0.6")
    assert resolve_trusted_proxy_ips() == "172.20.0.5,172.20.0.6"
    monkeypatch.delenv("TRUSTED_PROXY_IPS")
    assert resolve_trusted_proxy_ips() == TRUSTED_PROXY_IPS
