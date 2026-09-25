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


class LoginThrottle:
    """Fixed-window brute-force throttle for the single shared admin password.

    The admin API authenticates with one shared secret, so an unauthenticated
    attacker only needs to guess that one value; without a throttle /login is an
    unlimited online guessing oracle (no lockout, no delay, no audit trail), and
    a win is full admin takeover -- rewrite the agent prompt, read every
    transcript and recording. Failures are counted per client and globally: the
    per-client bucket stops a single host, the global bucket stops a distributed
    spray that rotates source addresses. Successful logins clear the client
    bucket.

    Deliberately in-process: this is a single admin app, and an in-memory
    counter cannot be bypassed by an attacker who cannot reach the process.
    Behind a shared proxy every request carries the proxy address, which
    degrades to the global bucket -- still a cap, never an open oracle.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: int = 300,
        global_max_failures: int = 50,
    ) -> None:
        self.max_failures = max_failures
        self.window = timedelta(seconds=window_seconds)
        self.global_max_failures = global_max_failures
        self._failures: dict[str, list[datetime]] = {}
        self._global: list[datetime] = []

    def _prune(self, stamps: list[datetime], now: datetime) -> list[datetime]:
        cutoff = now - self.window
        return [s for s in stamps if s > cutoff]

    def check(self, client: str, now: datetime | None = None) -> None:
        """Raise 429 when the client or the process is locked out."""
        now = now or datetime.now(UTC)
        self._global = self._prune(self._global, now)
        stamps = self._prune(self._failures.get(client, []), now)
        if stamps:
            self._failures[client] = stamps
        else:
            self._failures.pop(client, None)
        if len(stamps) >= self.max_failures or len(self._global) >= self.global_max_failures:
            retry_after = str(int(self.window.total_seconds()))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many failed login attempts",
                headers={"Retry-After": retry_after},
            )

    def record_failure(self, client: str, now: datetime | None = None) -> None:
        now = now or datetime.now(UTC)
        self._failures.setdefault(client, []).append(now)
        self._global.append(now)

    def record_success(self, client: str) -> None:
        self._failures.pop(client, None)
