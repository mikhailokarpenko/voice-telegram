from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol


class EventType(StrEnum):
    AUDIO = "audio"
    CALLER_TRANSCRIPT = "caller_transcript"
    AGENT_TRANSCRIPT = "agent_transcript"
    SPEECH_STARTED = "speech_started"
    SPEECH_STOPPED = "speech_stopped"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class RealtimeEvent:
    type: EventType
    data: str = ""


@dataclass(frozen=True, slots=True)
class RealtimeSession:
    instructions: str
    opening_message: str
    voice: str = ""
    vad_threshold: float = 0.5
    silence_duration_ms: int = 500


class RealtimeConnection(Protocol):
    async def configure(self, session: RealtimeSession) -> None: ...

    async def send_audio(self, payload: str) -> None: ...

    async def cancel_response(self) -> None: ...

    async def create_response(self) -> None: ...

    def events(self) -> AsyncIterator[RealtimeEvent]: ...

    async def close(self) -> None: ...


class RealtimeProvider(Protocol):
    async def connect(self) -> RealtimeConnection: ...
