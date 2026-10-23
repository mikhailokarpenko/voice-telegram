"""Tests for configuration."""

from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

from voice_telegram.config import Settings


def test_settings_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Test loading settings from environment variables."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost/db")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("LITELLM_REALTIME_MODEL", "litellm/realtime-xai")
    monkeypatch.setenv("OPENAI_VOICE", "alloy")
    monkeypatch.setenv("TELEGRAM_API_ID", "123456")
    monkeypatch.setenv("TELEGRAM_API_HASH", "test-hash")
    monkeypatch.setenv("TELEGRAM_PHONE", "+1234567890")
    monkeypatch.setenv("MAX_CALL_SECONDS", "600")
    monkeypatch.setenv("VAD_THRESHOLD", "0.6")
    monkeypatch.setenv("SILENCE_DURATION_MS", "600")
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-password")
    monkeypatch.setenv("ADMIN_JWT_SECRET", "x" * 32)

    settings = Settings(_env_file=None)

    assert settings.environment == "production"
    assert settings.log_level == "DEBUG"
    assert settings.database_url == "postgresql+asyncpg://user:pass@localhost/db"
    assert settings.litellm_api_key == SecretStr("sk-test-key")
    assert settings.litellm_realtime_model == "litellm/realtime-xai"
    assert settings.openai_voice == "alloy"
    assert settings.telegram_api_id == 123456
    assert settings.telegram_api_hash == SecretStr("test-hash")
    assert settings.telegram_phone == "+1234567890"
    assert settings.max_call_seconds == 600
    assert settings.vad_threshold == 0.6
    assert settings.silence_duration_ms == 600


def test_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Test default values for settings."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost/db")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("TELEGRAM_API_ID", "123456")
    monkeypatch.setenv("TELEGRAM_API_HASH", "test-hash")
    monkeypatch.setenv("TELEGRAM_PHONE", "+1234567890")

    settings = Settings(_env_file=None)

    assert settings.environment == "development"
    assert settings.log_level == "INFO"
    assert settings.litellm_realtime_model == "litellm/realtime-xai"
    assert settings.openai_voice == "marin"
    assert settings.max_call_seconds == 1800
    assert settings.vad_threshold == 0.5
    assert settings.silence_duration_ms == 500


def test_admin_secrets_have_no_generated_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_JWT_SECRET", raising=False)

    settings = Settings(_env_file=None)

    assert settings.admin_jwt_secret == ""
    assert settings.admin_password.get_secret_value() == ""


def test_production_requires_admin_credentials() -> None:
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, environment="production", admin_password="", admin_jwt_secret="")

    message = str(excinfo.value)
    assert "ADMIN_PASSWORD" in message
    assert "ADMIN_JWT_SECRET" in message


def test_production_rejects_short_jwt_secret() -> None:
    with pytest.raises(ValidationError, match="at least 32 characters"):
        Settings(
            _env_file=None,
            environment="production",
            admin_password="pw",
            admin_jwt_secret="short",
        )


def test_production_accepts_configured_admin_credentials() -> None:
    settings = Settings(
        _env_file=None, environment="production", admin_password="pw", admin_jwt_secret="s" * 32
    )

    assert settings.admin_jwt_secret == "s" * 32


def test_realtime_temperature_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Test default value for realtime_temperature."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost/db")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("TELEGRAM_API_ID", "123456")
    monkeypatch.setenv("TELEGRAM_API_HASH", "test-hash")
    monkeypatch.setenv("TELEGRAM_PHONE", "+1234567890")

    settings = Settings(_env_file=None)

    assert settings.realtime_temperature == 0.8


def test_realtime_temperature_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Test loading realtime_temperature from environment variable."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost/db")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("TELEGRAM_API_ID", "123456")
    monkeypatch.setenv("TELEGRAM_API_HASH", "test-hash")
    monkeypatch.setenv("TELEGRAM_PHONE", "+1234567890")
    monkeypatch.setenv("REALTIME_TEMPERATURE", "1.0")

    settings = Settings(_env_file=None)

    assert settings.realtime_temperature == 1.0


def test_realtime_temperature_rejects_below_minimum() -> None:
    """Test that values below 0.6 are rejected."""
    with pytest.raises(ValidationError, match="greater than or equal to 0.6"):
        Settings(_env_file=None, realtime_temperature=0.5)


def test_realtime_temperature_rejects_above_maximum() -> None:
    """Test that values above 1.2 are rejected."""
    with pytest.raises(ValidationError, match="less than or equal to 1.2"):
        Settings(_env_file=None, realtime_temperature=1.3)
