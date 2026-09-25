"""BAS-213 follow-up: security response headers on the voice-telegram service.

Second layer behind the admin-dashboard escaping: if an escaper regresses, CSP
still blocks exfiltration of transcripts/recordings to an attacker host, and
frame-ancestors/X-Frame-Options block clickjacking of the admin controls.
"""

from fastapi.testclient import TestClient

from voice_telegram.config import Settings
from voice_telegram.main import create_app
from voice_telegram.security_headers import CSP


def _client(public_base_url: str) -> TestClient:
    settings = Settings(
        admin_password="testpass",
        admin_jwt_secret="test-secret",
        public_base_url=public_base_url,
    )
    return TestClient(create_app(settings, start_telegram=False))


def _assert_headers(resp, *, https: bool) -> None:
    csp = resp.headers["content-security-policy"]
    directives = dict(
        (part.split(" ", 1) + [""])[:2] for part in (p.strip() for p in csp.split(";")) if part
    )
    assert directives["default-src"] == "'self'"
    assert directives["frame-ancestors"] == "'none'"
    assert directives["object-src"] == "'none'"
    assert directives["base-uri"] == "'none'"
    assert directives["connect-src"] == "'self'"
    assert directives["media-src"] == "'self'"
    assert directives["form-action"] == "'self'"
    assert directives["style-src"] == "'self' https://cdn.jsdelivr.net"
    assert "unsafe-inline" not in csp
    # BAS-217: no inline script is served by this service, so script-src is
    # exactly 'self'. No 'unsafe-inline', no remote host, no data:, no wildcard
    # -- each of those would hand a regressed escaper a loader back.
    assert directives["script-src"] == "'self'"
    assert "unsafe-eval" not in csp
    assert "*" not in csp
    assert resp.headers["x-frame-options"] == "DENY"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert resp.headers["cross-origin-opener-policy"] == "same-origin"
    assert "microphone=()" in resp.headers["permissions-policy"]
    if https:
        assert "max-age=31536000" in resp.headers["strict-transport-security"]
    else:
        assert "strict-transport-security" not in resp.headers


def test_headers_on_health_response() -> None:
    resp = _client("http://testserver").get("/health/ready")
    assert resp.status_code == 200
    _assert_headers(resp, https=False)


def test_headers_on_unauthenticated_admin_response() -> None:
    resp = _client("http://testserver").get("/api/admin/me")
    assert resp.status_code == 401
    _assert_headers(resp, https=False)


def test_hsts_only_on_https_deployments() -> None:
    _assert_headers(_client("https://tg.example.com").get("/health/ready"), https=True)


def test_csp_has_no_wildcard_or_unsafe_eval() -> None:
    assert "*" not in CSP
    assert "unsafe-eval" not in CSP


def test_headers_cover_unmatched_routes() -> None:
    # 404s are generated inside Starlette, below the route handlers. A payload
    # can trigger them, so they must carry the policy too.
    resp = _client("http://testserver").get("/definitely-not-a-route")
    assert resp.status_code == 404
    _assert_headers(resp, https=False)
