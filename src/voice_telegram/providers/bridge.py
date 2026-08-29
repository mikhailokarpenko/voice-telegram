"""OpenAI Realtime API bridge for Telegram voice agent.

This is a thin wrapper around the OpenAIRealtimeConnection that handles
the audio format differences (PCM16 base64 encoding for Telegram).
"""

import base64
import logging

from websockets.asyncio.client import connect

from voice_telegram.config import Settings
from voice_telegram.providers.base import EventType, RealtimeEvent, RealtimeSession
from voice_telegram.providers.openai import OpenAIRealtimeConnection

log = logging.getLogger(__name__)


class RealtimeBridge:
    def __init__(
        self,
        settings: Settings,
        session: RealtimeSession,
    ) -> None:
        self.settings = settings
        self.session = session
        self.connection: OpenAIRealtimeConnection | None = None

    async def connect(self) -> None:
        api_key = self.settings.litellm_api_key.get_secret_value()
        if not api_key:
            raise RuntimeError("LITELLM_API_KEY is required")

        base_url = self.settings.litellm_base_url.rstrip("/")
        websocket_url = base_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        socket = await connect(
            f"{websocket_url}/v1/realtime?model={self.settings.litellm_realtime_model}",
            additional_headers={
                "Authorization": f"Bearer {api_key}",
            },
            open_timeout=15,
            ping_interval=20,
            ping_timeout=20,
            max_size=2**20,
        )

        self.connection = OpenAIRealtimeConnection(socket, self.settings)
        await self.connection.configure(self.session)

    async def send_audio(self, pcm: bytes) -> None:
        """Send PCM16 audio to OpenAI (base64 encoded)."""
        if not self.connection or not pcm:
            return
        b64 = base64.b64encode(pcm).decode("utf-8")
        await self.connection.send_audio(b64)

    async def cancel_response(self) -> None:
        if self.connection:
            await self.connection.cancel_response()

    async def create_response(self) -> None:
        if self.connection:
            await self.connection.create_response()

    async def events(self):
        """Yield events from the OpenAI Realtime API."""
        if not self.connection:
            return
        async for event in self.connection.events():
            # Decode base64 audio back to PCM16
            if event.type == EventType.AUDIO and event.data:
                try:
                    pcm = base64.b64decode(event.data)
                    yield RealtimeEvent(EventType.AUDIO, pcm)
                except Exception as exc:
                    log.error("Failed to decode audio: %s", exc)
            else:
                yield event

    async def close(self) -> None:
        if self.connection:
            await self.connection.close()
