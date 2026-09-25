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

