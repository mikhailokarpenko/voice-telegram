import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

import uvicorn
from fastapi import FastAPI

from voice_telegram.admin.auth import LoginThrottle
from voice_telegram.admin.routes import router as admin_router
from voice_telegram.config import Settings, get_settings
from voice_telegram.database import Database
from voice_telegram.security_headers import install_security_headers
from voice_telegram.telegram.client import TelegramVoiceClient

# Reverse-proxy addresses whose X-Forwarded-For is trusted. Never "*": with "*",
# uvicorn's ProxyHeadersMiddleware rewrites scope["client"] from the first
# X-Forwarded-For entry supplied by ANY peer, so an unauthenticated caller
# rotates that header and gets a fresh per-client bucket on every admin /login
# attempt -- the brute-force throttle's per-client half is void.
#
# The default is loopback-only on purpose. The earlier fix pinned trust to the
# whole RFC1918/ULA space, but the service shares its Docker networks with every
# other container on the host: anything inside 172.16.0.0/12 (a co-resident
# container, an SSRF pivot) still rotates X-Forwarded-For freely, so the
# per-client bucket stayed attacker-chosen. Measured: peer 172.20.0.3, 12
# guesses with rotating XFF -> 12x401, 0x429.
#
# Deployments that terminate at a reverse proxy set TRUSTED_PROXY_IPS to that
# proxy's exact address. Leaving it unset is safe: every request then buckets
# under the proxy's own address, degrading the per-client half to the global
# cap instead of disabling it. Kept in sync with the deployed command by
# scripts/check-login-throttle.mjs.
TRUSTED_PROXY_IPS = "127.0.0.1,::1"


def resolve_trusted_proxy_ips(value: str | None = None) -> str:
    """Return the proxy trust list, rejecting the wildcard.

    "*" (and an empty value, which uvicorn treats as unpinned) must never be
    accepted from the environment: it is the exact configuration that made the
    login throttle bypassable.
    """
    resolved = (value if value is not None else os.environ.get("TRUSTED_PROXY_IPS")) or ""
    resolved = resolved.strip()
    if not resolved:
        return TRUSTED_PROXY_IPS
    if "*" in resolved:
        raise ValueError(
            "TRUSTED_PROXY_IPS must not contain '*': trusting X-Forwarded-For from every "
            "peer lets an unauthenticated caller rotate the admin login throttle's bucket key"
        )
    return resolved


# Fail fast at import time rather than serving with a wildcard trust list.
resolve_trusted_proxy_ips()


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
    install_security_headers(app, public_base_url=resolved_settings.public_base_url)
    app.state.settings = resolved_settings
    # Brute-force throttle for the single shared admin password. Installed here,
    # not in lifespan, so it exists for any caller that builds the app without
    # running startup.
    app.state.login_throttle = LoginThrottle()
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
        # Never "*". With "*", uvicorn's ProxyHeadersMiddleware rewrites
        # scope["client"] from the FIRST X-Forwarded-For entry supplied by ANY
        # peer, so an unauthenticated caller rotates that header and gets a
        # fresh per-client bucket on every admin /login attempt -- the
        # brute-force throttle's per-client half is void and only the global
        # cap remains (~14k guesses/day against one shared password). Trust is
        # pinned to loopback + RFC1918/ULA, where the container-network reverse
        # proxy actually connects from. Guarded by
        # scripts/check-login-throttle.mjs.
        forwarded_allow_ips=resolve_trusted_proxy_ips(),
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
