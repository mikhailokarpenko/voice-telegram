from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession


async def get_db_session(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in request.app.state.database.session():
        yield session
