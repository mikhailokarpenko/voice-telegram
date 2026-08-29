"""Telegram userbot with Pyrogram for voice calls.

Wires incoming Telegram audio to the OpenAI Realtime API and streams the
AI response back to the caller.
"""

import asyncio
import logging
import time
from collections import deque
from typing import Optional

from pyrogram import Client
from pyrogram.raw.types import PhoneCallDiscarded, PhoneCallRequested, UpdatePhoneCall
from pytgcalls import PyTgCalls
from pytgcalls import filters as tgfilters
from pytgcalls.types import (
    CallConfig,
    Device,
    Direction,
    ExternalMedia,
    Frame,
    MediaStream,
    RecordStream,
    StreamEnded,
    StreamFrames,
)
from pytgcalls.types.raw import AudioParameters

from voice_telegram.audio import (
    TELEGRAM_FRAME_BYTES,
    reset_resamplers,
    resample_24k_to_48k_stereo,
    resample_48k_to_24k_mono,
)
from voice_telegram.config import Settings
from voice_telegram.providers.base import EventType, RealtimeSession
from voice_telegram.providers.bridge import RealtimeBridge

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
    def __init__(self, settings: Settings, database: Optional[object]) -> None:
        self.settings = settings
        self.app: Optional[Client] = None
        self.pytgcalls: Optional[PyTgCalls] = None
        self._active_user_id: Optional[int] = None
        self._active_call_id: Optional[int] = None
        self._bridge: Optional[RealtimeBridge] = None
        self._event_task: Optional[asyncio.Task] = None
        self._audio_sender_task: Optional[asyncio.Task] = None
        self._outbound_buf = bytearray()
        self._outbound_frames: deque[bytes] = deque()

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
                log.info(
                    "Incoming call from %s (call_id=%s)", caller_id, call_id
                )
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
        reset_resamplers()

        try:
            # Accept the call with an external-media stream so we can push
            # audio frames programmatically.
            await self.pytgcalls.play(
                user_id,
                MediaStream(
                    ExternalMedia.AUDIO,
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
        except Exception:
            log.exception("Failed to answer call from %s", user_id)
            self._active_user_id = None
            self._active_call_id = None
            return

        # Open the OpenAI Realtime bridge
        try:
            session = RealtimeSession(
                instructions=SYSTEM_PROMPT,
                opening_message=OPENING_MESSAGE,
                voice=self.settings.openai_voice,
                vad_threshold=self.settings.vad_threshold,
                silence_duration_ms=self.settings.silence_duration_ms,
            )
            self._bridge = RealtimeBridge(self.settings, session)
            await self._bridge.connect()
            log.info("OpenAI Realtime bridge connected")

            # Start consuming OpenAI events in the background
            self._event_task = asyncio.create_task(self._consume_openai_events())
            self._audio_sender_task = asyncio.create_task(self._audio_sender())
        except Exception:
            log.exception("Failed to connect OpenAI bridge")
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
                elif event.type == EventType.AGENT_TRANSCRIPT:
                    log.info("Agent said: %s", event.data)
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
        loop = asyncio.get_running_loop()
        silence_frame = b"\x00" * TELEGRAM_FRAME_BYTES
        playing = False
        concealment_frames = 0
        start_wall = time.time()
        start_mono = loop.time()
        frame_index = 0

        while self.pytgcalls and self._active_user_id:
            if not playing:
                if len(self._outbound_frames) < 28:
                    await asyncio.sleep(0.002)
                    continue
                playing = True
                concealment_frames = 0
                start_wall = time.time()
                start_mono = loop.time()
                frame_index = 0

            if self._outbound_frames:
                frame = self._outbound_frames.popleft()
                concealment_frames = 0
            elif concealment_frames < 2:
                frame = silence_frame
                concealment_frames += 1
            else:
                log.warning("Playback underrun after %d frames", frame_index)
                playing = False
                continue

            if frame_index % 100 == 0:
                log.info("Playback frame %d, queued=%d", frame_index, len(self._outbound_frames))
            capture_time = int((start_wall + frame_index * 0.02) * 1000)
            try:
                await self.pytgcalls.send_frame(
                    self._active_user_id,
                    Device.MICROPHONE,
                    frame,
                    Frame.Info(capture_time=capture_time),
                )
            except Exception:
                log.exception("Error sending frame to Telegram")
                return

            frame_index += 1
            sleep_time = frame_index * 0.02 - (loop.time() - start_mono)
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

    # ------------------------------------------------------------------ #
    # Cleanup                                                              #
    # ------------------------------------------------------------------ #

    async def _teardown_call(self) -> None:
        """Close the OpenAI bridge and reset call state."""
        if self._audio_sender_task and not self._audio_sender_task.done():
            self._audio_sender_task.cancel()
            try:
                await self._audio_sender_task
            except asyncio.CancelledError:
                pass
            self._audio_sender_task = None

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
