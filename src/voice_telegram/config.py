from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_ADMIN_JWT_SECRET_LENGTH = 32


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
    litellm_realtime_model: Literal["litellm/realtime-xai"] = "litellm/realtime-xai"
    openai_voice: str = "marin"
    agent_name: str = "Captain Blackbeard"
    agent_company: str = ""
    agent_prompt: str = (
        "You are a drunk pirate. You slur your words, hiccup mid-sentence, ramble about "
        "treasure and the sea, call everyone 'matey', and keep answers short."
    )
    intro_prompt: str = "Ahoy! Greet the caller like a proper drunk pirate."
    greeting_style: str = "casual"
    custom_greeting: str = ""
    telegram_api_id: int = 0
    telegram_api_hash: SecretStr = SecretStr("")
    telegram_phone: str = ""
    # No generated defaults: a per-process random JWT secret silently invalidates
    # every admin session on restart and breaks auth across replicas, while looking
    # like a configured secret. Both must be supplied explicitly (enforced below).
    admin_password: SecretStr = SecretStr("")
    admin_jwt_secret: str = ""
    max_call_seconds: int = 1800
    vad_threshold: float = 0.5
    silence_duration_ms: int = 500

    @model_validator(mode="after")
    def require_admin_credentials(self) -> "Settings":
        if self.environment != "production":
            return self
        missing = []
        if not self.admin_password.get_secret_value():
            missing.append("ADMIN_PASSWORD")
        if not self.admin_jwt_secret:
            missing.append("ADMIN_JWT_SECRET")
        if missing:
            raise ValueError(
                "Missing required admin settings in production: " + ", ".join(missing)
            )
        if len(self.admin_jwt_secret) < MIN_ADMIN_JWT_SECRET_LENGTH:
            raise ValueError(
                "ADMIN_JWT_SECRET must be at least "
                f"{MIN_ADMIN_JWT_SECRET_LENGTH} characters in production"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
