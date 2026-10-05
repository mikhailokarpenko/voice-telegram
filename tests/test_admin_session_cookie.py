"""BAS-261: the admin session cookie's flags are the third layer of the
BAS-213/BAS-217 defence stack.

Escaping is the first layer, CSP the second. If both are bypassed, HttpOnly is
what stops the injected script from reading the admin session; SameSite=Strict
is what stops a cross-site POST from riding it; Secure is what stops it from
being sent over cleartext on an https deployment.

None of those three flags changes any status code or response body, so every
other test in this suite stays green if one is dropped. These assert the raw
Set-Cookie attributes directly.
"""

from http.cookies import SimpleCookie

import pytest
from fastapi.testclient import TestClient

from voice_telegram.config import Settings
from voice_telegram.main import create_app

COOKIE_NAME = "admin_token"


def _client(public_base_url: str = "http://testserver") -> TestClient:
    settings = Settings(
        admin_password="testpass",
        admin_jwt_secret="test-secret",
        public_base_url=public_base_url,
    )
    return TestClient(create_app(settings, start_telegram=False))


def _login_cookie(public_base_url: str = "http://testserver"):
    resp = _client(public_base_url).post("/api/admin/login", json={"password": "testpass"})
    assert resp.status_code == 200
    matching = [
        header
        for header in resp.headers.get_list("set-cookie")
        if header.startswith(f"{COOKIE_NAME}=")
    ]
    assert len(matching) == 1, f"expected one {COOKIE_NAME} Set-Cookie, got {matching!r}"
    jar = SimpleCookie()
    jar.load(matching[0])
    return jar[COOKIE_NAME]


def test_admin_session_cookie_is_httponly() -> None:
    # Without this, any XSS that survives the escaper and the CSP can read the
    # admin JWT out of document.cookie.
    assert _login_cookie()["httponly"]


def test_admin_session_cookie_is_samesite_strict() -> None:
    assert _login_cookie()["samesite"].lower() == "strict"


def test_admin_session_cookie_is_not_secure_on_http_deployments() -> None:
    # A Secure cookie on a plain-http deployment is never stored, so login
    # silently stops working; secure must track the scheme, not be hardcoded.
    assert not _login_cookie("http://testserver")["secure"]


def test_admin_session_cookie_is_secure_on_https_deployments() -> None:
    assert _login_cookie("https://telegram.example.com")["secure"]


@pytest.mark.parametrize("scheme_url", ["http://testserver", "https://telegram.example.com"])
def test_admin_session_cookie_is_scoped_to_the_whole_site(scheme_url: str) -> None:
    assert _login_cookie(scheme_url)["path"] == "/"
