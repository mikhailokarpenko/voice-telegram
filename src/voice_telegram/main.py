import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

import uvicorn
from fastapi import FastAPI

from voice_telegram.admin.routes import router as admin_router
from voice_telegram.config import Settings, get_settings
from voice_telegram.database import Database
from voice_telegram.telegram.client import TelegramVoiceClient


def create_app(settings: Settings | None = None, *, start_telegram: bool = True) -> FastAPI:
    resolved_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = Database(resolved_settings)
        telegram = TelegramVoiceClient(resolved_settings, database)
        app.state.settings = resolved_settings
        app.state.database = database
        app.state.telegram = telegram
        telegram_task = asyncio.create_task(telegram.start()) if start_telegram else None
        yield
        if telegram_task:
            await telegram.stop()
            telegram_task.cancel()
            with suppress(asyncio.CancelledError):
                await telegram_task
        await database.close()

    app = FastAPI(title="Telegram Voice Agent", version="0.1.0", lifespan=lifespan)
    app.state.settings = resolved_settings
    app.include_router(admin_router)

    @app.get("/health/ready")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "voice_telegram.main:app",
        host="0.0.0.0",
        port=8000,
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
