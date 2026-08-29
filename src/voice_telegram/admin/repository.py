from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from voice_telegram.admin.models import AgentConfig


class AgentConfigRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_active(self) -> AgentConfig | None:
        return cast(
            AgentConfig | None,
            await self.session.scalar(
                select(AgentConfig).where(AgentConfig.is_active.is_(True)).limit(1)
            ),
        )

    async def upsert(self, data: dict[str, Any]) -> AgentConfig:
        active = await self.get_active()
        if active:
            for key, value in data.items():
                setattr(active, key, value)
            await self.session.flush()
            return active
        config = AgentConfig(**data, is_active=True)
        self.session.add(config)
        await self.session.flush()
        return config
