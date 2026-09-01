import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from voice_telegram.calls.models import Base


class AgentConfig(Base):
    __tablename__ = "agent_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_name: Mapped[str] = mapped_column(String(128), default="Assistant")
    agent_company: Mapped[str] = mapped_column(String(128), default="")
    agent_prompt: Mapped[str] = mapped_column(Text, default="You are a helpful voice assistant.")
    intro_prompt: Mapped[str] = mapped_column(Text, default="")
    openai_voice: Mapped[str] = mapped_column(String(32), default="marin")
    max_call_seconds: Mapped[int] = mapped_column(Integer, default=1800)
    greeting_style: Mapped[str] = mapped_column(String(32), default="casual")
    custom_greeting: Mapped[str] = mapped_column(Text, default="")
    vad_threshold: Mapped[float] = mapped_column(Float, default=0.5)
    silence_duration_ms: Mapped[int] = mapped_column(Integer, default=500)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
