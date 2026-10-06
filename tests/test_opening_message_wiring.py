"""BAS-237: the resolved greeting must reach the provider frame.

`tests/test_opening_message.py` covers `build_opening_message` as a pure
function and `scripts/check-greeting-config.mjs` is a *static* guard: both can
stay green while the answer path passes the wrong field (or `intro_prompt`
again) into `RealtimeSession`, which is exactly the BAS-234 bug. These tests
drive the real answer path with a fake pytgcalls and a stubbed RealtimeBridge,
then feed the captured session through the real OpenAI connection and assert
on the `conversation.item.create` payload the provider would put on the wire.
"""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from voice_telegram.config import Settings
from voice_telegram.providers.base import RealtimeSession
from voice_telegram.providers.openai import OpenAIRealtimeConnection
from voice_telegram.telegram import client as client_module
from voice_telegram.telegram.client import TelegramVoiceClient

pytestmark = pytest.mark.asyncio


class FakeCall:
    def __init__(self) -> None:
        self.id = uuid.uuid4()
        self.status = "new"
        self.transcript = ""


class FakeCallRepository:
    def __init__(self, session: Any) -> None:
        pass

    async def create(self, *, telegram_user_id: int, direction: str = "inbound") -> FakeCall:
        return FakeCall()

    async def get(self, call_id: uuid.UUID) -> FakeCall | None:
        return None

    async def set_status(self, call: FakeCall, status: str, error: str | None = None) -> None:
        call.status = status

    async def save_transcript(self, call: FakeCall, lines: list[str]) -> None:
        call.transcript = "\n".join(lines)


class FakeDatabase:
    async def session(self):  # type: ignore[no-untyped-def]
        yield object()


class FakeAgentConfig:
    """An active admin row. Values deliberately differ from the env defaults."""

    def __init__(self, **overrides: Any) -> None:
        self.max_call_seconds = 0
        self.agent_prompt = "row prompt"
        self.greeting_style = "casual"
        self.custom_greeting = ""
        self.intro_prompt = ""
        self.agent_name = "RowAgent"
        self.agent_company = "RowCo"
        self.openai_voice = "marin"
        self.vad_threshold = 0.5
        self.silence_duration_ms = 500
        for key, value in overrides.items():
            setattr(self, key, value)


def _settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "litellm_api_key": "sk-test",
        "telegram_api_id": 1,
        "telegram_api_hash": "hash",
        "telegram_phone": "+10000000000",
        "admin_password": "pw",
        "admin_jwt_secret": "x" * 32,
    }
    base.update(overrides)
    return Settings(**base)


async def _answer_and_capture(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    active_config: FakeAgentConfig | None,
    **settings_overrides: Any,
) -> RealtimeSession:
    """Run `_answer_call` far enough to capture the RealtimeSession."""
    monkeypatch.setattr(client_module, "TelegramCallRepository", FakeCallRepository)

    class FakeAgentConfigRepository:
        def __init__(self, session: Any) -> None:
            pass

        async def get_active(self) -> FakeAgentConfig | None:
            return active_config

    monkeypatch.setattr(client_module, "AgentConfigRepository", FakeAgentConfigRepository)

    captured: dict[str, RealtimeSession] = {}

    class FakeBridge:
        def __init__(self, settings: Settings, session: RealtimeSession) -> None:
            captured["session"] = session

        async def connect(self) -> None:
            return None

        async def events(self):  # type: ignore[no-untyped-def]
            if False:  # pragma: no cover - never yields
                yield None
            await asyncio.sleep(0)

    monkeypatch.setattr(client_module, "RealtimeBridge", FakeBridge)

    client = TelegramVoiceClient(_settings(**settings_overrides), FakeDatabase())  # type: ignore[arg-type]
    client.pytgcalls = AsyncMock()
    client._audio_fifo = tmp_path / f"out-{uuid.uuid4().hex}.pcm"

    await client._answer_call(user_id=4242, call_id=1, access_hash=2)

    if client._event_task:
        client._event_task.cancel()
    if client._max_call_task:
        client._max_call_task.cancel()
    if client._audio_sender_task:
        client._audio_sender_task.cancel()
    await asyncio.sleep(0)

    assert "session" in captured, "the answer path never opened a realtime session"
    return captured["session"]


async def _provider_frames(session: RealtimeSession) -> list[dict[str, Any]]:
    """Feed the session through the real provider and collect sent frames."""
    sent: list[dict[str, Any]] = []

    class FakeSocket:
        async def send(self, raw: str) -> None:
            sent.append(json.loads(raw))

    connection = OpenAIRealtimeConnection(FakeSocket(), _settings())  # type: ignore[arg-type]
    await connection.configure(session)
    return sent


def _opening_text(frames: list[dict[str, Any]]) -> str:
    items = [f for f in frames if f["type"] == "conversation.item.create"]
    assert len(items) == 1, f"expected exactly one opening item, got {len(items)}"
    return items[0]["item"]["content"][0]["text"]


# --------------------------------------------------------------------------- #
# Branch 1: custom greeting, including the precedence that differs from phone  #
# --------------------------------------------------------------------------- #


async def test_custom_greeting_reaches_the_provider_frame(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(
            greeting_style="custom",
            custom_greeting="  Hey, Ada here.  ",
            intro_prompt="SHOULD NOT BE SPOKEN",
        ),
    )
    assert _opening_text(await _provider_frames(session)) == "Hey, Ada here."


async def test_blank_custom_greeting_falls_through_to_intro_prompt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(
            greeting_style="custom",
            custom_greeting="   ",
            intro_prompt="Thanks for calling.",
        ),
    )
    assert _opening_text(await _provider_frames(session)) == "Thanks for calling."


# --------------------------------------------------------------------------- #
# Branch 3: synthesised greeting — and never the empty string                  #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("style", ["casual", "formal", "friendly", "professional"])
async def test_every_blank_knob_still_sends_a_named_styled_greeting(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, style: str
) -> None:
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(
            greeting_style=style,
            custom_greeting="",
            intro_prompt="",
            agent_name="Ada",
            agent_company="Acme",
        ),
    )
    text = _opening_text(await _provider_frames(session))
    assert text.strip()
    assert "Ada" in text
    assert "Acme" in text
    assert style in text


async def test_the_opening_item_is_never_empty(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An empty item makes the agent open the call with silence."""
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(
            greeting_style="", custom_greeting="", intro_prompt="", agent_company=""
        ),
    )
    text = _opening_text(await _provider_frames(session))
    assert text.strip() != ""
    # A blank style must still name a tone, otherwise the provider receives
    # "... in a  tone." and the style knob silently degrades the prompt.
    assert "casual" in text
    assert "in a  tone" not in text


# --------------------------------------------------------------------------- #
# Branch 4: the active row outranks env; env is used when no row is active     #
# --------------------------------------------------------------------------- #


async def test_active_row_overrides_env_for_both_greeting_knobs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(
            greeting_style="custom", custom_greeting="Row greeting."
        ),
        greeting_style="custom",
        custom_greeting="Env greeting.",
        intro_prompt="Env intro.",
    )
    assert _opening_text(await _provider_frames(session)) == "Row greeting."


async def test_env_settings_are_used_when_no_row_is_active(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session = await _answer_and_capture(
        monkeypatch,
        tmp_path,
        active_config=None,
        greeting_style="custom",
        custom_greeting="Env greeting.",
        intro_prompt="Env intro.",
    )
    assert _opening_text(await _provider_frames(session)) == "Env greeting."
