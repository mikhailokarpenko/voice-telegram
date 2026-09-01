import secrets
from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    public_base_url: str = "http://localhost:8000"
    database_url: str = (
        "postgresql+asyncpg://voice_telegram:voice_telegram@localhost:5432/voice_telegram"
    )
    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: SecretStr = SecretStr("")
    litellm_realtime_model: Literal["litellm/realtime-main"] = "litellm/realtime-main"
    openai_voice: str = "marin"
    agent_name: str = "Captain Blackbeard"
    agent_company: str = ""
    agent_prompt: str = (
        "You are a drunk pirate. You slur your words, hiccup mid-sentence, ramble about "
        "treasure and the sea, call everyone 'matey', and keep answers short."
    )
    intro_prompt: str = "Ahoy!"
    greeting_style: str = "casual"
    custom_greeting: str = ""
    telegram_api_id: int = 0
    telegram_api_hash: SecretStr = SecretStr("")
    telegram_phone: str = ""
    admin_password: SecretStr = SecretStr("")
    admin_jwt_secret: str = secrets.token_urlsafe(32)
    max_call_seconds: int = 1800
    vad_threshold: float = 0.5
    silence_duration_ms: int = 500
    recording_storage_path: str = "/app/recordings"


@lru_cache
def get_settings() -> Settings:
    return Settings()
