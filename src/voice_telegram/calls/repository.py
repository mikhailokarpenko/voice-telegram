import uuid
from datetime import UTC, datetime
from typing import cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from voice_telegram.calls.models import TelegramCall


class TelegramCallRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        telegram_user_id: int,
        direction: str = "inbound",
    ) -> TelegramCall:
        call = TelegramCall(
            telegram_user_id=str(telegram_user_id),
            direction=direction,
        )
        self.session.add(call)
        await self.session.flush()
        return call

    async def get(self, call_id: uuid.UUID) -> TelegramCall | None:
        return await self.session.get(TelegramCall, call_id)

    async def get_by_user_id(self, user_id: int) -> TelegramCall | None:
        return cast(
            TelegramCall | None,
            await self.session.scalar(
                select(TelegramCall).where(TelegramCall.telegram_user_id == str(user_id))
            ),
        )

    async def set_status(self, call: TelegramCall, status: str, error: str | None = None) -> None:
        call.status = status
        call.error = error
        if status in {"completed", "failed", "canceled"}:
            call.ended_at = datetime.now(UTC)
        await self.session.flush()

    async def save_transcript(self, call: TelegramCall, lines: list[str]) -> None:
        call.transcript = "\n".join(lines)
        await self.session.flush()
