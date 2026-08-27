"""Main entry point for the Telegram voice agent."""

import asyncio
import logging

from voice_telegram.config import Settings, get_settings
from voice_telegram.telegram.client import TelegramVoiceClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


async def main() -> None:
    settings = get_settings()
    client = TelegramVoiceClient(settings, None)
    await client.start()

    try:
        # Keep running until interrupted
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        await client.stop()


if __name__ == "__main__":
    asyncio.run(main())
