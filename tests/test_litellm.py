import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from voice_telegram.config import Settings
from voice_telegram.providers.base import RealtimeSession
from voice_telegram.providers.bridge import RealtimeBridge
from voice_telegram.providers.openai import OpenAIRealtimeConnection
from voice_telegram.telegram.client import (
    MULTILINGUAL_INSTRUCTION,
    LivePCMStream,
    append_transcript_turn,
    build_agent_instructions,
)


@pytest.mark.asyncio
async def test_bridge_uses_exact_litellm_realtime_model() -> None:
    socket = AsyncMock()
    settings = Settings(
        litellm_base_url="http://litellm:4000",
        litellm_api_key="dedicated-key",
        litellm_realtime_model="litellm/realtime-xai",
    )
    bridge = RealtimeBridge(
        settings,
        RealtimeSession(instructions="test", opening_message="hello"),
    )

    with patch(
        "voice_telegram.providers.bridge.connect", AsyncMock(return_value=socket)
    ) as connect:
        await bridge.connect()

    assert connect.await_args.args[0] == (
        "ws://litellm:4000/v1/realtime?model=litellm/realtime-xai"
    )
    assert connect.await_args.kwargs["additional_headers"] == {
        "Authorization": "Bearer dedicated-key"
    }


@pytest.mark.asyncio
async def test_session_update_includes_temperature() -> None:
    """Test that the session.update payload includes the configured temperature."""
    socket = MagicMock()
    socket.send = AsyncMock()

    settings = Settings(realtime_temperature=1.0)
    connection = OpenAIRealtimeConnection(socket, settings)

    session = RealtimeSession(
        instructions="test instructions",
        opening_message="hello",
        temperature=1.0,
    )

    await connection.configure(session)

    # Verify that the session.update payload includes temperature
    assert socket.send.call_count >= 1
    first_call = socket.send.call_args_list[0]

    payload = json.loads(first_call.args[0])
    assert payload["type"] == "session.update"
    assert "temperature" in payload["session"]
    assert payload["session"]["temperature"] == 1.0


def test_agent_instructions_preserve_website_prompt_and_enable_multilingual() -> None:
    instructions = build_agent_instructions("A persona configured on the website.")

    assert instructions.startswith("A persona configured on the website.")
    assert instructions.endswith(MULTILINGUAL_INSTRUCTION)
    assert "same language" in instructions


def test_transcript_keeps_latest_revision_per_turn() -> None:
    transcript: list[str] = []

    append_transcript_turn(transcript, "Caller", "Мне пора.")
    append_transcript_turn(transcript, "Caller", "Мне пора работать.")
    append_transcript_turn(transcript, "Caller", "Мне пора работать.")
    append_transcript_turn(transcript, "Agent", "До встречи!")
    append_transcript_turn(transcript, "Caller", "Пока.")

    assert transcript == [
        "Caller: Мне пора работать.",
        "Agent: До встречи!",
        "Caller: Пока.",
    ]


def test_transcript_ignores_empty_revisions() -> None:
    transcript = ["Agent: Hello"]

    append_transcript_turn(transcript, "Caller", "  ")

    assert transcript == ["Agent: Hello"]


@pytest.mark.asyncio
async def test_live_pcm_stream_bypasses_probe_and_uses_realtime_ffmpeg() -> None:
    stream = LivePCMStream("/tmp/audio pipe.pcm")

    await stream.check_stream()

    assert "ffmpeg -f s16le -ar 48000 -ac 2 -re" in stream.microphone.path
    assert "'/tmp/audio pipe.pcm'" in stream.microphone.path
    assert "ffprobe" not in stream.microphone.path
