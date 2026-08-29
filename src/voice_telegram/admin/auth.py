import hmac
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import HTTPException, status

from voice_telegram.config import Settings

_TOKEN_EXPIRY_HOURS = 24
_ALGORITHM = "HS256"


def verify_password(plain: str, settings: Settings) -> bool:
    stored = settings.admin_password.get_secret_value()
    return bool(stored) and hmac.compare_digest(plain.encode(), stored.encode())


def create_token(settings: Settings) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": "admin",
        "exp": now + timedelta(hours=_TOKEN_EXPIRY_HOURS),
        "iat": now,
    }
    return jwt.encode(payload, settings.admin_jwt_secret, algorithm=_ALGORITHM)


def decode_token(token: str, settings: Settings) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.admin_jwt_secret, algorithms=[_ALGORITHM])  # type: ignore[no-any-return]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from None
