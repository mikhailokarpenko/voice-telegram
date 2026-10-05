"""BAS-260: behavioural tests for the per-call duration budget.

`max_call_seconds` is a DoS control of the same class as the voice-phone
media-WS caps (BAS-226/BAS-236): a call that neither side hangs up (silent
caller, wedged pytgcalls stream, a provider socket that pings forever) runs
until the process restarts, billing realtime minutes the whole time and
holding this service's single call slot so every later caller gets nothing.

BAS-230 added the watchdog. `scripts/check-call-duration-budget.mjs` only
greps for it statically: until this file, deleting the asyncio timer kept
every test green. These tests execute it — the budget fires *at*
`max_call_seconds`, not before, hangs the call up through the normal teardown
path, is cancelled when the call ends first, and an active admin-config row
outranks the env default (otherwise the dashboard slider is decorative).

Time is virtual: a fake clock stands in for `asyncio.sleep` inside the client
module so "has not fired at budget-1s" is an assertion about the budget and
not about wall-clock flakiness.
"""

import asyncio
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from voice_telegram.config import Settings
from voice_telegram.telegram import client as client_module
from voice_telegram.telegram.client import TelegramVoiceClient

# --------------------------------------------------------------------------- #
# Virtual clock                                                               #
# --------------------------------------------------------------------------- #


class FakeClock:
    """Deterministic stand-in for asyncio.sleep.

    Every sleep registers a deadline and parks; `advance(n)` moves virtual
    time forward and wakes only the sleepers whose deadline has passed. A
    watchdog whose sleep was removed or shortened therefore fires at a
    virtual time we can assert on exactly.
    """

    def __init__(self) -> None:
        self.now = 0.0
        self._sleepers: list[tuple[float, asyncio.Future[None]]] = []
        self.slept: list[float] = []

    async def sleep(self, delay: float, result: Any = None) -> Any:
        self.slept.append(delay)
        if delay <= 0:
            await _yield()
            return result
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._sleepers.append((self.now + delay, future))
        await future
        return result

    async def advance(self, seconds: float) -> None:
        self.now += seconds
        due = [(d, f) for d, f in self._sleepers if d <= self.now]
        self._sleepers = [(d, f) for d, f in self._sleepers if d > self.now]
        for _, future in due:
            if not future.done():
                future.set_result(None)
        await _yield()


async def _yield(times: int = 6) -> None:
    """Let parked coroutines run to their next await point."""
    for _ in range(times):
        await asyncio.sleep(0)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    fake = FakeClock()
    real_sleep = asyncio.sleep

    async def patched(delay: float, result: Any = None) -> Any:
        if delay == 0:
            return await real_sleep(0, result)
        return await fake.sleep(delay, result)

    monkeypatch.setattr(client_module.asyncio, "sleep", patched)
    return fake


# --------------------------------------------------------------------------- #
# Stand-ins for the DB layer                                                  #
# --------------------------------------------------------------------------- #


class FakeCall:
    def __init__(self) -> None:
        self.id = uuid.uuid4()
        self.status = "new"
        self.transcript = ""


class FakeCallRepository:
    """Shared-state stand-in: one call row per test."""

    state: dict[str, Any] = {}

    def __init__(self, session: Any) -> None:
        pass

    async def create(self, *, telegram_user_id: int, direction: str = "inbound") -> FakeCall:
        call = FakeCall()
        FakeCallRepository.state["call"] = call
        return call

    async def get(self, call_id: uuid.UUID) -> FakeCall | None:
        call = FakeCallRepository.state.get("call")
        return call if call and call.id == call_id else None

    async def set_status(self, call: FakeCall, status: str, error: str | None = None) -> None:
        call.status = status
        FakeCallRepository.state.setdefault("statuses", []).append(status)

    async def save_transcript(self, call: FakeCall, lines: list[str]) -> None:
        call.transcript = "\n".join(lines)


class FakeDatabase:
    async def session(self):  # type: ignore[no-untyped-def]
        yield object()


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


def _client(monkeypatch: pytest.MonkeyPatch, **settings_overrides: Any) -> TelegramVoiceClient:
    FakeCallRepository.state = {}
    monkeypatch.setattr(client_module, "TelegramCallRepository", FakeCallRepository)
    client = TelegramVoiceClient(_settings(**settings_overrides), FakeDatabase())  # type: ignore[arg-type]
    client.pytgcalls = AsyncMock()
    client._active_user_id = 4242
    return client


# --------------------------------------------------------------------------- #
# The watchdog itself                                                         #
# --------------------------------------------------------------------------- #


async def test_budget_does_not_fire_before_max_call_seconds(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    task = asyncio.create_task(client._enforce_max_call_seconds(600))
    await _yield()

    await clock.advance(599)

    assert not task.done()
    client.pytgcalls.leave_call.assert_not_awaited()
    assert client._active_user_id == 4242

    task.cancel()


async def test_budget_fires_at_max_call_seconds_and_hangs_the_call_up(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    task = asyncio.create_task(client._enforce_max_call_seconds(600))
    await _yield()

    await clock.advance(600)
    await asyncio.wait_for(task, timeout=1)

    client.pytgcalls.leave_call.assert_awaited_once_with(4242)
    # The hangup goes through the normal teardown path, not a bare leave_call:
    # call state must be released so the next caller gets the slot.
    assert client._active_user_id is None


async def test_budget_waits_for_the_configured_budget_not_a_hardcoded_one(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    task = asyncio.create_task(client._enforce_max_call_seconds(90))
    await _yield()

    assert clock.slept == [90]

    await clock.advance(90)
    await asyncio.wait_for(task, timeout=1)
    client.pytgcalls.leave_call.assert_awaited_once_with(4242)


async def test_budget_saves_the_transcript_and_completes_the_call_row(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    """A timed-out call must not be left stuck "in-progress"."""
    client = _client(monkeypatch)
    call = FakeCall()
    FakeCallRepository.state["call"] = call
    client._call_record_id = call.id
    client._transcript = ["Caller: hello", "Agent: ahoy"]

    task = asyncio.create_task(client._enforce_max_call_seconds(300))
    await _yield()
    await clock.advance(300)
    await asyncio.wait_for(task, timeout=1)

    assert call.status == "completed"
    assert call.transcript == "Caller: hello\nAgent: ahoy"


async def test_budget_of_zero_is_an_explicit_opt_out_that_never_hangs_up(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)

    await asyncio.wait_for(client._enforce_max_call_seconds(0), timeout=1)

    assert clock.slept == []
    client.pytgcalls.leave_call.assert_not_awaited()
    assert client._active_user_id == 4242


async def test_negative_budget_does_not_hang_every_call_up_immediately(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    """asyncio.sleep(-1) returns at once; the guard must short-circuit first."""
    client = _client(monkeypatch)

    await asyncio.wait_for(client._enforce_max_call_seconds(-1), timeout=1)

    client.pytgcalls.leave_call.assert_not_awaited()
    assert client._active_user_id == 4242


async def test_budget_does_not_hang_up_a_call_that_already_ended(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    task = asyncio.create_task(client._enforce_max_call_seconds(120))
    await _yield()
    client._active_user_id = None

    await clock.advance(120)
    await asyncio.wait_for(task, timeout=1)

    client.pytgcalls.leave_call.assert_not_awaited()


async def test_a_failing_leave_call_still_tears_the_call_down(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    client.pytgcalls.leave_call.side_effect = RuntimeError("peer gone")

    task = asyncio.create_task(client._enforce_max_call_seconds(60))
    await _yield()
    await clock.advance(60)
    await asyncio.wait_for(task, timeout=1)

    assert client._active_user_id is None


# --------------------------------------------------------------------------- #
# Arming on the answer path + config precedence                               #
# --------------------------------------------------------------------------- #


class FakeAgentConfig:
    def __init__(self, max_call_seconds: int) -> None:
        self.max_call_seconds = max_call_seconds
        self.agent_prompt = "prompt"
        self.greeting_style = "casual"
        self.custom_greeting = ""
        self.intro_prompt = "intro"
        self.agent_name = "Ada"
        self.agent_company = "Acme"
        self.openai_voice = "marin"
        self.vad_threshold = 0.5
        self.silence_duration_ms = 500


async def _noop() -> None:
    return None


def _arm_recorder(client: TelegramVoiceClient, armed: list[int]) -> None:
    """Record the budget at arm time.

    The body of an `async def` does not run until the task is scheduled, and
    the answer path's failure branch cancels the watchdog first, so the
    recorder must be a plain function returning a coroutine.
    """

    def record(max_seconds: int):  # type: ignore[no-untyped-def]
        armed.append(max_seconds)
        return _noop()

    client._enforce_max_call_seconds = record  # type: ignore[method-assign]


async def _answer(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    active_config: FakeAgentConfig | None,
    env_seconds: int,
) -> list[int]:
    client = _client(monkeypatch, max_call_seconds=env_seconds)
    client._audio_fifo = tmp_path / "out.pcm"

    class FakeAgentConfigRepository:
        def __init__(self, session: Any) -> None:
            pass

        async def get_active(self) -> FakeAgentConfig | None:
            return active_config

    monkeypatch.setattr(client_module, "AgentConfigRepository", FakeAgentConfigRepository)
    # Stop the answer path right after the budget is armed.
    client.pytgcalls.play.side_effect = RuntimeError("stop here")

    armed: list[int] = []
    _arm_recorder(client, armed)

    await client._answer_call(user_id=4242, call_id=1, access_hash=2)
    return armed


async def test_answer_path_arms_the_watchdog_from_the_env_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    armed = await _answer(monkeypatch, tmp_path, active_config=None, env_seconds=900)
    assert armed == [900]


async def test_active_admin_config_overrides_the_env_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without this the admin API's duration field is decorative."""
    armed = await _answer(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(max_call_seconds=120),
        env_seconds=900,
    )
    assert armed == [120]


async def test_admin_config_can_shorten_or_lengthen_the_budget(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    armed = await _answer(
        monkeypatch,
        tmp_path,
        active_config=FakeAgentConfig(max_call_seconds=3600),
        env_seconds=60,
    )
    assert armed == [3600]


async def test_answer_path_really_creates_a_live_watchdog_task(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, clock: FakeClock
) -> None:
    """The budget must be armed as a task, not merely computed."""
    client = _client(monkeypatch, max_call_seconds=300)
    client._audio_fifo = tmp_path / "out.pcm"

    class FakeAgentConfigRepository:
        def __init__(self, session: Any) -> None:
            pass

        async def get_active(self) -> None:
            return None

    monkeypatch.setattr(client_module, "AgentConfigRepository", FakeAgentConfigRepository)

    async def play_later(*args: Any, **kwargs: Any) -> None:
        # Yield first so the armed watchdog actually reaches its sleep.
        await _yield()
        raise RuntimeError("stop here")

    client.pytgcalls.play.side_effect = play_later

    await client._answer_call(user_id=4242, call_id=1, access_hash=2)

    # The watchdog ran and parked on the configured budget, then the failure
    # path tore the call down and cancelled it. (The audio sender parks on
    # its own frame-pacing sleeps, so assert on the budget specifically.)
    assert 300 in clock.slept
    assert client._max_call_task is None


async def test_teardown_cancels_the_watchdog_so_a_finished_call_is_not_hung_up_later(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    client = _client(monkeypatch)
    client._max_call_task = asyncio.create_task(client._enforce_max_call_seconds(600))
    await _yield()

    await client._teardown_call()
    client.pytgcalls.reset_mock()

    await clock.advance(10_000)

    assert client._max_call_task is None
    client.pytgcalls.leave_call.assert_not_awaited()
