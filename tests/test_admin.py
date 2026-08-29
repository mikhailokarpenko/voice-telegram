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
