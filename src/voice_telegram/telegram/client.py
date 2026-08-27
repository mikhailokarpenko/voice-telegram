"""Telegram userbot with Pyrogram for voice calls."""

import asyncio
import logging
from typing import Optional

from pyrogram import Client, filters
from pyrogram.raw.functions.phone import AcceptCall, DiscardCall
from pyrogram.raw.types import InputPhoneCall, PhoneCallDiscarded, PhoneCallRequested, UpdatePhoneCall

from voice_telegram.config import Settings

log = logging.getLogger(__name__)


class TelegramVoiceClient:
    def __init__(self, settings: Settings, database: Optional[object]) -> None:
        self.settings = settings
        self.app: Optional[Client] = None
        self._active_user_id: Optional[int] = None
        self._active_call_id: Optional[int] = None
        self._active_access_hash: Optional[int] = None

    async def start(self) -> None:
        """Start the Telegram client."""
        self.app = Client(
            name="voice_telegram_session",
            api_id=self.settings.telegram_api_id,
            api_hash=self.settings.telegram_api_hash.get_secret_value(),
            phone_number=self.settings.telegram_phone,
            workdir="/app/sessions",
        )

        @self.app.on_raw_update()
        async def on_raw(client: Client, update, users: dict, chats: dict) -> None:
            if not isinstance(update, UpdatePhoneCall):
                return

            phone_call = update.phone_call
            if isinstance(phone_call, PhoneCallRequested):
                caller_id = phone_call.admin_id
                call_id = phone_call.id
                access_hash = phone_call.access_hash
                log.info("Incoming call from %s (call_id: %s, access_hash: %s)", caller_id, call_id, access_hash)
                
                # Answer the call automatically
                try:
                    await self._answer_call(call_id, access_hash)
                    self._active_user_id = caller_id
                    self._active_call_id = call_id
                    self._active_access_hash = access_hash
                    log.info("Call answered successfully")
                except Exception as e:
                    log.error("Failed to answer call: %s", e, exc_info=True)
                    
            elif isinstance(phone_call, PhoneCallDiscarded):
                log.info("Call discarded (call_id: %s)", phone_call.id)
                self._active_user_id = None
                self._active_call_id = None
                self._active_access_hash = None

        await self.app.start()
        me = await self.app.get_me()
        log.info("Logged in as @%s (%s)", me.username, me.first_name)
        log.info("Waiting for calls (auto-answer enabled)")

    async def _answer_call(self, call_id: int, access_hash: int) -> None:
        """Answer an incoming phone call."""
        if not self.app:
            return
            
        input_call = InputPhoneCall(id=call_id, access_hash=access_hash)
        await self.app.invoke(AcceptCall(
            peer=input_call
        ))

    async def stop(self) -> None:
        """Stop the Telegram client."""
        if self._active_call_id and self._active_access_hash and self.app:
            try:
                input_call = InputPhoneCall(id=self._active_call_id, access_hash=self._active_access_hash)
                await self.app.invoke(DiscardCall(
                    peer=input_call,
                    duration=0,
                    reason=None,
                    connection_id=0
                ))
            except Exception as e:
                log.error("Error discarding call: %s", e)
                
        if self.app:
            await self.app.stop()
