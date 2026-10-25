"""Interactively create the Telegram session file used by the agent.

Pyrogram builds its first msg_id before it knows the server clock, so a fresh
process always fails once with BadMsgNotification 16; retrying works.
"""
import os

from pyrogram import Client
from pyrogram.errors import BadMsgNotification

client = Client(
    'voice_telegram_session',
    api_id=int(os.environ['TELEGRAM_API_ID']),
    api_hash=os.environ['TELEGRAM_API_HASH'],
    phone_number=os.environ['TELEGRAM_PHONE'],
    workdir='/app/sessions',
)

print("Starting authentication...")
for attempt in range(3):
    try:
        client.start()
        break
    except BadMsgNotification as exc:
        if attempt == 2:
            raise
        print(f"Clock not synced yet ({exc}); retrying")

print("Session created successfully")
client.stop()
