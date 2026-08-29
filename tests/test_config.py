"""Tests for configuration."""

from pathlib import Path

import pytest
from pydantic import SecretStr

from voice_telegram.config import Settings


def test_settings_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Test loading settings from environment variables."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost/db")
    monkeypatch.setenv("LITELLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("LITELLM_REALTIME_MODEL", "litellm/realtime-main")
    monkeypatch.setenv("OPENAI_VOICE", "alloy")
    monkeypatch.setenv("TELEGRAM_API_ID", "123456")
    monkeypatch.setenv("TELEGRAM_API_HASH", "test-hash")
    monkeypatch.setenv("TELEGRAM_PHONE", "+1234567890")
    monkeypatch.setenv("MAX_CALL_SECONDS", "600")
    monkeypatch.setenv("VAD_THRESHOLD", "0.6")
    monkeypatch.setenv("SILENCE_DURATION_MS", "600")

    settings = Settings()

    assert settings.environment == "production"
    assert settings.log_level == "DEBUG"
    assert settings.database_url == "postgresql+asyncpg://user:pass@localhost/db"
    assert settings.litellm_api_key == SecretStr("sk-test-key")
    assert settings.litellm_realtime_model == "litellm/realtime-main"
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

    settings = Settings()

    assert settings.environment == "development"
    assert settings.log_level == "INFO"
    assert settings.litellm_realtime_model == "litellm/realtime-main"
    assert settings.openai_voice == "marin"
    assert settings.max_call_seconds == 1800
    assert settings.vad_threshold == 0.5
    assert settings.silence_duration_ms == 500
