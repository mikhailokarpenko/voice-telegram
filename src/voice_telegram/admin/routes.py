import asyncio
import math
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from voice_telegram.admin.auth import create_token, decode_token, verify_password
from voice_telegram.admin.repository import AgentConfigRepository
from voice_telegram.api.dependencies import get_db_session
from voice_telegram.calls.models import TelegramCall
from voice_telegram.config import Settings

router = APIRouter(prefix="/api/admin", tags=["admin"])

AVAILABLE_VOICES = [
    {"id": voice.lower(), "label": voice}
    for voice in [
        "Alloy",
        "Ash",
        "Ballad",
        "Coral",
        "Echo",
        "Fable",
        "Marin",
        "Nova",
        "Onyx",
        "Sage",
        "Shimmer",
        "Verse",
    ]
]


class LoginRequest(BaseModel):
    password: str


class ConfigPayload(BaseModel):
    agent_name: str = Field(max_length=128)
    agent_company: str = Field(default="", max_length=128)
    agent_prompt: str
    intro_prompt: str = "Ahoy!"
    openai_voice: str = Field(default="marin", max_length=32)
    max_call_seconds: int = Field(default=1800, ge=60, le=7200)
    greeting_style: str = Field(default="casual", max_length=32)
    custom_greeting: str = ""
    vad_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    silence_duration_ms: int = Field(default=500, ge=100, le=3000)


class ConfigResponse(ConfigPayload):
    id: str | None = None
    is_active: bool = True
    source: str = "defaults"


class CallItem(BaseModel):
    id: str
    telegram_user_id: str
    direction: str
    status: str
    created_at: datetime
    ended_at: datetime | None = None
    transcript: str | None = None
    error: str | None = None
    has_recording: bool = False


class CallListResponse(BaseModel):
    items: list[CallItem]
    total: int
    page: int
    page_size: int
    total_pages: int


def _get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


async def _require_auth(
    request: Request, admin_token: str | None = Cookie(default=None)
) -> dict[str, Any]:
    if not admin_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return decode_token(admin_token, _get_settings(request))


@router.post("/login")
async def login(body: LoginRequest, request: Request) -> Response:
    settings = _get_settings(request)
    if not verify_password(body.password, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid password")
    response = Response(content='{"status":"ok"}', media_type="application/json")
    response.set_cookie(
        "admin_token",
        create_token(settings),
        httponly=True,
        samesite="strict",
        secure=settings.public_base_url.startswith("https"),
        max_age=86400,
        path="/",
    )
    return response


@router.post("/logout")
async def logout() -> Response:
    response = Response(content='{"status":"ok"}', media_type="application/json")
    response.delete_cookie("admin_token", path="/")
    return response


@router.get("/me")
async def me(_claims: dict[str, Any] = Depends(_require_auth)) -> dict[str, str]:
    return {"status": "ok", "user": "admin"}


def _config_response(config: Any, source: str) -> ConfigResponse:
    return ConfigResponse(
        id=str(config.id) if getattr(config, "id", None) else None,
        agent_name=config.agent_name,
        agent_company=config.agent_company,
        agent_prompt=config.agent_prompt,
        intro_prompt=getattr(config, "intro_prompt", ""),
        openai_voice=config.openai_voice,
        max_call_seconds=config.max_call_seconds,
        greeting_style=getattr(config, "greeting_style", "casual"),
        custom_greeting=getattr(config, "custom_greeting", ""),
        vad_threshold=config.vad_threshold,
        silence_duration_ms=config.silence_duration_ms,
        source=source,
    )


@router.get("/config", response_model=ConfigResponse)
async def get_config(
    request: Request,
    session: AsyncSession = Depends(get_db_session),
    _claims: dict[str, Any] = Depends(_require_auth),
) -> ConfigResponse:
    active = await AgentConfigRepository(session).get_active()
    return _config_response(active or _get_settings(request), "database" if active else "defaults")


@router.put("/config", response_model=ConfigResponse)
async def update_config(
    body: ConfigPayload,
    session: AsyncSession = Depends(get_db_session),
    _claims: dict[str, Any] = Depends(_require_auth),
) -> ConfigResponse:
    config = await AgentConfigRepository(session).upsert(body.model_dump())
    return _config_response(config, "database")


@router.get("/calls", response_model=CallListResponse)
async def list_calls(
    page: int = 1,
    page_size: int = 20,
    call_status: str | None = None,
    session: AsyncSession = Depends(get_db_session),
    _claims: dict[str, Any] = Depends(_require_auth),
) -> CallListResponse:
    page, page_size = max(page, 1), min(max(page_size, 1), 100)
    query = select(TelegramCall).order_by(TelegramCall.created_at.desc())
    count_query = select(func.count(TelegramCall.id))
    if call_status:
        query = query.where(TelegramCall.status == call_status)
        count_query = count_query.where(TelegramCall.status == call_status)
    total = (await session.scalar(count_query)) or 0
    calls = (await session.scalars(query.offset((page - 1) * page_size).limit(page_size))).all()
    return CallListResponse(
        items=[
            CallItem(
                id=str(call.id),
                telegram_user_id=call.telegram_user_id,
                direction=call.direction,
                status=call.status,
                created_at=call.created_at,
                ended_at=call.ended_at,
                transcript=call.transcript,
                error=call.error,
                has_recording=bool(call.recording_key),
            )
            for call in calls
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=max(1, math.ceil(total / page_size)),
    )


@router.get("/calls/{call_id}", response_model=CallItem)
async def get_call(
    call_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    _claims: dict[str, Any] = Depends(_require_auth),
) -> CallItem:
    call = await session.get(TelegramCall, call_id)
    if not call:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call not found")
    return CallItem(
        id=str(call.id),
        telegram_user_id=call.telegram_user_id,
        direction=call.direction,
        status=call.status,
        created_at=call.created_at,
        ended_at=call.ended_at,
        transcript=call.transcript,
        error=call.error,
        has_recording=bool(call.recording_key),
    )


@router.get("/calls/{call_id}/recording", response_class=FileResponse)
async def get_call_recording(
    call_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
    _claims: dict[str, Any] = Depends(_require_auth),
) -> FileResponse:
    call = await session.get(TelegramCall, call_id)
    if not call:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call not found")
    if not call.recording_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")

    def resolve_recording() -> Path | None:
        root = Path(_get_settings(request).recording_storage_path).resolve()
        path = (root / call.recording_key).resolve()
        return path if path.is_relative_to(root) and path.is_file() else None

    recording_path = await asyncio.to_thread(resolve_recording)
    if not recording_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    return FileResponse(
        recording_path,
        media_type="audio/wav",
        filename=f"call-{call.id}.wav",
    )


@router.get("/voices")
async def list_voices(
    _claims: dict[str, Any] = Depends(_require_auth),
) -> list[dict[str, str]]:
    return AVAILABLE_VOICES
