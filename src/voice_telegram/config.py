import secrets
from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+asyncpg://voice_telegram:voice_telegram@localhost:5432/voice_telegram"
    openai_api_key: SecretStr = SecretStr("")
    openai_realtime_model: str = "gpt-realtime-2.1"
    openai_voice: str = "marin"
    telegram_api_id: int = 0
    telegram_api_hash: SecretStr = SecretStr("")
    telegram_phone: str = ""
    admin_password: SecretStr = SecretStr("")
    admin_jwt_secret: str = secrets.token_urlsafe(32)
    max_call_seconds: int = 1800
    vad_threshold: float = 0.5
    silence_duration_ms: int = 500


@lru_cache
def get_settings() -> Settings:
    return Settings()
