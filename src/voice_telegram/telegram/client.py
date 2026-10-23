"""Telegram userbot with Pyrogram for voice calls.

Wires incoming Telegram audio to the OpenAI Realtime API and streams the
AI response back to the caller.
"""

import asyncio
import logging
import os
import shlex
import uuid
from collections import deque
from pathlib import Path

from pyrogram import Client
from pyrogram.raw.types import PhoneCallDiscarded, PhoneCallRequested, UpdatePhoneCall
from pytgcalls import PyTgCalls
from pytgcalls import filters as tgfilters
from pytgcalls.types import (
    CallConfig,
    Direction,
    MediaStream,
    RecordStream,
    StreamEnded,
    StreamFrames,
)
from pytgcalls.types.raw import AudioParameters

from voice_telegram.admin.repository import AgentConfigRepository
from voice_telegram.audio import (
    TELEGRAM_FRAME_BYTES,
    resample_24k_to_48k_stereo,
    resample_48k_to_24k_mono,
    reset_resamplers,
)
from voice_telegram.calls.repository import TelegramCallRepository
from voice_telegram.config import Settings
from voice_telegram.database import Database
from voice_telegram.providers.base import EventType, RealtimeSession
from voice_telegram.providers.bridge import RealtimeBridge

MULTILINGUAL_INSTRUCTION = (
    "Automatically detect the language spoken by the caller and respond naturally in the same "
    "language. If the caller changes languages, switch to match them. Preserve the configured "
    "persona and never translate unless asked."
)


def build_agent_instructions(agent_prompt: str) -> str:
    return f"{agent_prompt.strip()}\n\n{MULTILINGUAL_INSTRUCTION}"


def build_opening_message(
    *,
    greeting_style: str,
    custom_greeting: str,
    intro_prompt: str,
    agent_name: str,
    agent_company: str,
) -> str:
    """Resolve the first thing the agent says.

    `greeting_style` and `custom_greeting` exist as env settings, agent_configs
    columns, validated admin-API fields and a voice-web dropdown. Until BAS-234
    nothing in this service read either one: the opening was always
    `intro_prompt`, so selecting "custom" in the dashboard and typing a greeting
    changed a stored row and nothing else. Precedence here differs deliberately
    from voice-phone: there `intro_prompt` is spoken over a separate Twilio
    <Say> channel so the realtime opening is blanked, whereas this client has
    only one channel, so an explicit custom greeting wins over it.

    Never returns empty: the provider unconditionally sends the opening as a
    conversation item, and an empty item makes the agent open with silence.
    """
    if greeting_style == "custom" and custom_greeting.strip():
        return custom_greeting.strip()
    if intro_prompt.strip():
        return intro_prompt.strip()
    style = (greeting_style or "casual").strip() or "casual"
    return (
        f"Greet the caller as {agent_name}"
        + (f" from {agent_company}" if agent_company else "")
        + f" in a {style} tone. Briefly ask how you can help."
    )


def append_transcript_turn(transcript: list[str], speaker: str, text: str) -> None:
    normalized = text.strip()
    if not normalized:
        return
    line = f"{speaker}: {normalized}"
    if transcript and transcript[-1].startswith(f"{speaker}: "):
        transcript[-1] = line
    else:
        transcript.append(line)


class LivePCMStream(MediaStream):
    async def check_stream(self) -> None:
        path = shlex.quote(str(self._audio_path or self._media_path))
        self.microphone.path = (
            f"ffmpeg -f s16le -ar 48000 -ac 2 -re -i {path} "
            "-v quiet -f s16le -ac 2 -ar 48000 pipe:1"
        )


log = logging.getLogger(__name__)

# Drunk-pirate system prompt
SYSTEM_PROMPT = (
    "You are a drunk pirate. You slur your words, hiccup mid-sentence, "
    "ramble about treasure and the sea, call everyone 'matey', and pepper "
    "your speech with 'arr', 'yarr', 'shiver me timbers', and similar "
    "pirate exclamations. You are friendly but incoherent — sometimes you "
    "lose your train of thought and start talking about rum or your parrot. "
    "Keep answers short (1-3 sentences). Never break character."
)

OPENING_MESSAGE = "Ahoy! A new matey be callin'! Greet them like a proper drunk pirate."


class TelegramVoiceClient:
    def __init__(self, settings: Settings, database: Database) -> None:
        self.settings = settings
        self.database = database
        self.app: Client | None = None
        self.pytgcalls: PyTgCalls | None = None
        self._active_user_id: int | None = None
        self._active_call_id: int | None = None
        self._bridge: RealtimeBridge | None = None
        self._event_task: asyncio.Task[None] | None = None
        self._audio_sender_task: asyncio.Task[None] | None = None
        self._outbound_buf = bytearray()
        self._outbound_frames: deque[bytes] = deque()
        self._audio_fifo = Path("/tmp/voice-telegram-output.pcm")
        self._audio_fifo_fd: int | None = None
        self._call_record_id: uuid.UUID | None = None
        self._transcript: list[str] = []
        self._max_call_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle                                                           #
    # ------------------------------------------------------------------ #

    async def start(self) -> None:
        """Start the Telegram client."""
        self.app = Client(
            name="voice_telegram_session",
            api_id=self.settings.telegram_api_id,
            api_hash=self.settings.telegram_api_hash.get_secret_value(),
            phone_number=self.settings.telegram_phone,
            workdir="/app/sessions",
        )

        self.pytgcalls = PyTgCalls(self.app)

        @self.pytgcalls.on_update(tgfilters.stream_frame())
        async def on_frame(client: PyTgCalls, update: StreamFrames) -> None:
            if update.direction != Direction.INCOMING:
                return
            for frame in update.frames:
                if frame.frame:
                    await self._forward_to_openai(frame.frame)

        @self.pytgcalls.on_update(tgfilters.stream_end())
        async def on_stream_end(client: PyTgCalls, update: StreamEnded) -> None:
            log.info("Stream ended (%s)", update.chat_id)
            await self._teardown_call()

        # Setup phone call event handlers
        @self.app.on_raw_update()
        async def on_raw(client: Client, update, users: dict, chats: dict) -> None:
            if not isinstance(update, UpdatePhoneCall):
                return

            phone_call = update.phone_call
            log.info("Phone call update: %s", type(phone_call).__name__)
            if isinstance(phone_call, PhoneCallRequested):
                caller_id = phone_call.admin_id
                call_id = phone_call.id
                access_hash = phone_call.access_hash
                log.info("Incoming call from %s (call_id=%s)", caller_id, call_id)
                await self._answer_call(caller_id, call_id, access_hash)
            elif isinstance(phone_call, PhoneCallDiscarded):
                reason = getattr(phone_call, "reason", None)
                log.info("Call discarded (reason: %s)", reason)
                await self._teardown_call()

        await self.app.start()
        await self.pytgcalls.start()

        me = await self.app.get_me()
        log.info("Logged in as @%s (%s)", me.username, me.first_name)
        log.info("Waiting for calls (auto-answer enabled)")

    async def stop(self) -> None:
        """Stop the Telegram client."""
        await self._teardown_call()

        if self._active_user_id and self.pytgcalls:
            try:
                await self.pytgcalls.leave_call(self._active_user_id)
            except Exception:
                log.exception("Error leaving call")

        if self.app:
            await self.app.stop()

    # ------------------------------------------------------------------ #
    # Call handling                                                        #
    # ------------------------------------------------------------------ #

    async def _answer_call(self, user_id: int, call_id: int, access_hash: int) -> None:
        """Answer an incoming phone call and connect the OpenAI bridge."""
        if not self.pytgcalls:
            log.error("pytgcalls not initialized")
            return

        self._active_user_id = user_id
        self._active_call_id = call_id
        self._outbound_buf.clear()
        self._outbound_frames.clear()
        self._transcript.clear()
        reset_resamplers()

        active_config = None
        async for db_session in self.database.session():
            active_config = await AgentConfigRepository(db_session).get_active()
            call = await TelegramCallRepository(db_session).create(telegram_user_id=user_id)
            await TelegramCallRepository(db_session).set_status(call, "in-progress")
            self._call_record_id = call.id

        # Hard per-call duration budget. `max_call_seconds` is configurable via
        # env, the agent_configs row and the admin API, but until BAS-230
        # nothing in this service ever read it: a call that neither side hung up
        # (silent caller, wedged pytgcalls stream, a provider socket that pings
        # forever) ran until the process restarted, billing realtime minutes the
        # whole time and holding the single-call slot so every later caller got
        # nothing. voice-phone arms the same budget with asyncio.timeout around
        # its bridge; this client is event-driven with no such scope, so the
        # budget is a watchdog task that forces the normal hangup path.
        max_seconds = (
            active_config.max_call_seconds if active_config else self.settings.max_call_seconds
        )
        self._max_call_task = asyncio.create_task(self._enforce_max_call_seconds(max_seconds))

        try:
            self._audio_fifo.unlink(missing_ok=True)
            os.mkfifo(self._audio_fifo)
            self._audio_fifo_fd = os.open(self._audio_fifo, os.O_RDWR)
            self._audio_sender_task = asyncio.create_task(self._audio_sender())
            await self.pytgcalls.play(
                user_id,
                LivePCMStream(
                    str(self._audio_fifo),
                    audio_parameters=AudioParameters(bitrate=48000, channels=2),
                    audio_flags=MediaStream.Flags.REQUIRED,
                    video_flags=MediaStream.Flags.IGNORE,
                ),
                config=CallConfig(timeout=30),
            )
            # Capture inbound audio from the caller.
            await self.pytgcalls.record(
                user_id,
                RecordStream(
                    audio=True,
                    audio_parameters=AudioParameters(bitrate=48000, channels=1),
                ),
            )
            log.info("Call answered for user %s", user_id)
        except Exception as exc:
            log.exception("Failed to answer call from %s", user_id)
            if self._call_record_id:
                async for db_session in self.database.session():
                    repo = TelegramCallRepository(db_session)
                    call = await repo.get(self._call_record_id)
                    if call:
                        await repo.set_status(call, "failed", str(exc))
                self._call_record_id = None
            await self._teardown_call()
            return

        # Open the OpenAI Realtime bridge
        try:
            session = RealtimeSession(
                instructions=build_agent_instructions(
                    active_config.agent_prompt if active_config else self.settings.agent_prompt
                ),
                opening_message=build_opening_message(
                    greeting_style=(
                        active_config.greeting_style
                        if active_config
                        else self.settings.greeting_style
                    ),
                    custom_greeting=(
                        active_config.custom_greeting
                        if active_config
                        else self.settings.custom_greeting
                    ),
                    intro_prompt=(
                        active_config.intro_prompt if active_config else self.settings.intro_prompt
                    ),
                    agent_name=(
                        active_config.agent_name if active_config else self.settings.agent_name
                    ),
                    agent_company=(
                        active_config.agent_company
                        if active_config
                        else self.settings.agent_company
                    ),
                ),
                voice=(active_config.openai_voice if active_config else self.settings.openai_voice),
                vad_threshold=(
                    active_config.vad_threshold if active_config else self.settings.vad_threshold
                ),
                silence_duration_ms=(
                    active_config.silence_duration_ms
                    if active_config
                    else self.settings.silence_duration_ms
                ),
                temperature=self.settings.realtime_temperature,
            )
            self._bridge = RealtimeBridge(self.settings, session)
            await self._bridge.connect()
            log.info("OpenAI Realtime bridge connected")

            # Start consuming OpenAI events in the background
            self._event_task = asyncio.create_task(self._consume_openai_events())
        except Exception:
            log.exception("Failed to connect OpenAI bridge")
            await self._teardown_call()

    async def _enforce_max_call_seconds(self, max_seconds: int) -> None:
        """Hang up once the call exceeds its configured duration budget."""
        if max_seconds <= 0:
            return
        try:
            await asyncio.sleep(max_seconds)
        except asyncio.CancelledError:
            return
        user_id = self._active_user_id
        if user_id is None:
            return
        log.warning("Call from %s hit the %ss budget — hanging up", user_id, max_seconds)
        if self.pytgcalls:
            try:
                await self.pytgcalls.leave_call(user_id)
            except Exception:
                log.exception("Error leaving call after duration budget")
        await self._teardown_call()

    # ------------------------------------------------------------------ #
    # Audio pipeline: Telegram -> OpenAI                                   #
    # ------------------------------------------------------------------ #

    async def _forward_to_openai(self, pcm_48k: bytes) -> None:
        """Resample incoming Telegram audio and send to OpenAI."""
        if not self._bridge:
            return
        try:
            pcm_24k = resample_48k_to_24k_mono(pcm_48k)
            if pcm_24k:
                await self._bridge.send_audio(pcm_24k)
        except Exception:
            log.exception("Error forwarding audio to OpenAI")

    # ------------------------------------------------------------------ #
    # Audio pipeline: OpenAI -> Telegram                                   #
    # ------------------------------------------------------------------ #

    async def _consume_openai_events(self) -> None:
        """Read events from the OpenAI bridge and push audio to Telegram."""
        if not self._bridge:
            return
        try:
            async for event in self._bridge.events():
                if event.type == EventType.AUDIO and event.data:
                    log.info("Received audio from OpenAI: %d bytes", len(event.data))
                    await self._send_audio_to_telegram(event.data)
                elif event.type == EventType.SPEECH_STARTED:
                    # Caller started speaking — cancel any in-progress response
                    # so the AI doesn't talk over them (barge-in).
                    log.debug("Caller speech started — cancelling response")
                    await self._bridge.cancel_response()
                    self._outbound_buf.clear()
                    self._outbound_frames.clear()
                elif event.type == EventType.CALLER_TRANSCRIPT:
                    log.info("Caller said: %s", event.data)
                    append_transcript_turn(self._transcript, "Caller", event.data)
                elif event.type == EventType.AGENT_TRANSCRIPT:
                    log.info("Agent said: %s", event.data)
                    append_transcript_turn(self._transcript, "Agent", event.data)
                elif event.type == EventType.ERROR:
                    log.error("OpenAI error: %s", event.data)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("OpenAI event consumer crashed")

    async def _send_audio_to_telegram(self, pcm_24k: bytes) -> None:
        """Resample OpenAI audio to 48 kHz stereo and queue Telegram-sized frames."""
        if not self.pytgcalls or not self._active_user_id:
            return

        self._outbound_buf.extend(resample_24k_to_48k_stereo(pcm_24k))
        while len(self._outbound_buf) >= TELEGRAM_FRAME_BYTES:
            frame = bytes(self._outbound_buf[:TELEGRAM_FRAME_BYTES])
            del self._outbound_buf[:TELEGRAM_FRAME_BYTES]
            self._outbound_frames.append(frame)

    async def _audio_sender(self) -> None:
        if self._audio_fifo_fd is None:
            return

        loop = asyncio.get_running_loop()
        silence_frame = b"\x00" * TELEGRAM_FRAME_BYTES
        playing = False
        start_time = loop.time()
        frame_index = 0

        while self._active_user_id and self._audio_fifo_fd is not None:
            if not playing and len(self._outbound_frames) >= 28:
                playing = True
            if playing and not self._outbound_frames:
                playing = False

            frame = self._outbound_frames.popleft() if playing else silence_frame
            try:
                await asyncio.to_thread(os.write, self._audio_fifo_fd, frame)
            except OSError:
                log.exception("Error writing audio to playback FIFO")
                return

            frame_index += 1
            sleep_time = frame_index * 0.02 - (loop.time() - start_time)
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

    # ------------------------------------------------------------------ #
    # Cleanup                                                              #
    # ------------------------------------------------------------------ #

    async def _teardown_call(self) -> None:
        """Close the OpenAI bridge and reset call state."""
        if self._call_record_id:
            async for db_session in self.database.session():
                repo = TelegramCallRepository(db_session)
                call = await repo.get(self._call_record_id)
                if call:
                    await repo.save_transcript(call, self._transcript)
                    await repo.set_status(call, "completed")
            self._call_record_id = None

        # The watchdog itself calls teardown; never cancel the running task.
        current = asyncio.current_task()
        if (
            self._max_call_task
            and self._max_call_task is not current
            and not self._max_call_task.done()
        ):
            self._max_call_task.cancel()
            try:
                await self._max_call_task
            except asyncio.CancelledError:
                pass
        self._max_call_task = None

        if self._audio_sender_task and not self._audio_sender_task.done():
            self._audio_sender_task.cancel()
            try:
                await self._audio_sender_task
            except asyncio.CancelledError:
                pass
            self._audio_sender_task = None

        if self._audio_fifo_fd is not None:
            os.close(self._audio_fifo_fd)
            self._audio_fifo_fd = None
        self._audio_fifo.unlink(missing_ok=True)

        if self._event_task and not self._event_task.done():
            self._event_task.cancel()
            try:
                await self._event_task
            except asyncio.CancelledError:
                pass
            self._event_task = None

        if self._bridge:
            try:
                await self._bridge.close()
            except Exception:
                log.exception("Error closing OpenAI bridge")
            self._bridge = None

        self._active_user_id = None
        self._active_call_id = None
        self._outbound_buf.clear()
        self._outbound_frames.clear()
