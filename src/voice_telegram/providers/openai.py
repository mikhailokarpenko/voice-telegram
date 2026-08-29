import json
from collections.abc import AsyncIterator
from typing import Any

from websockets.asyncio.client import ClientConnection, connect

from voice_telegram.config import Settings
from voice_telegram.providers.base import EventType, RealtimeConnection, RealtimeEvent, RealtimeSession


class OpenAIRealtimeConnection(RealtimeConnection):
    def __init__(self, socket: ClientConnection, settings: Settings) -> None:
        self.socket = socket
        self.settings = settings

    async def configure(self, session: RealtimeSession) -> None:
        voice = session.voice or self.settings.openai_voice
        await self._send(
            {
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": session.instructions,
                    "output_modalities": ["audio"],
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": 24000},
                            "transcription": {"model": "whisper-1"},
                            "turn_detection": {
                                "type": "server_vad",
                                "threshold": session.vad_threshold,
                                "prefix_padding_ms": 300,
                                "silence_duration_ms": session.silence_duration_ms,
                            },
                        },
                        "output": {
                            "format": {"type": "audio/pcm", "rate": 24000},
                            "voice": voice,
                            "speed": 1.0,
                        },
                    },
                },
            }
        )
        await self._send(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": session.opening_message}],
                },
            }
        )
        await self._send({"type": "response.create"})

    async def send_audio(self, payload: str) -> None:
        # payload is base64-encoded PCM16 for Telegram
        await self._send({"type": "input_audio_buffer.append", "audio": payload})

    async def cancel_response(self) -> None:
        await self._send({"type": "response.cancel"})

    async def create_response(self) -> None:
        await self._send({"type": "response.create"})

    async def events(self) -> AsyncIterator[RealtimeEvent]:
        async for raw in self.socket:
            message = json.loads(raw)
            event = self._normalize(message)
            if event:
                yield event

    async def close(self) -> None:
        await self.socket.close()

    async def _send(self, payload: dict[str, Any]) -> None:
        await self.socket.send(json.dumps(payload))

    @staticmethod
    def _normalize(message: dict[str, Any]) -> RealtimeEvent | None:
        event_type = message.get("type")
        if event_type in {"response.audio.delta", "response.output_audio.delta"}:
            # OpenAI returns base64-encoded PCM16
            return RealtimeEvent(EventType.AUDIO, str(message.get("delta", "")))
        if event_type == "conversation.item.input_audio_transcription.completed":
            return RealtimeEvent(
                EventType.CALLER_TRANSCRIPT, str(message.get("transcript", ""))
            )
        if event_type in {
            "response.audio_transcript.done",
            "response.output_audio_transcript.done",
        }:
            return RealtimeEvent(
                EventType.AGENT_TRANSCRIPT, str(message.get("transcript", ""))
            )
        if event_type == "input_audio_buffer.speech_started":
            return RealtimeEvent(EventType.SPEECH_STARTED)
        if event_type == "input_audio_buffer.speech_stopped":
            return RealtimeEvent(EventType.SPEECH_STOPPED)
        if event_type == "error":
            return RealtimeEvent(EventType.ERROR, json.dumps(message.get("error", {})))
        return None


class OpenAIRealtimeProvider:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def connect(self) -> RealtimeConnection:
        api_key = self.settings.openai_api_key.get_secret_value()
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required")
        socket = await connect(
            f"wss://api.openai.com/v1/realtime?model={self.settings.openai_realtime_model}",
            additional_headers={
                "Authorization": f"Bearer {api_key}",
            },
            open_timeout=15,
            ping_interval=20,
            ping_timeout=20,
            max_size=2**20,
        )
        return OpenAIRealtimeConnection(socket, self.settings)
