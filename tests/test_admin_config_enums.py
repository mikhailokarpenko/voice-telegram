"""BAS-240: behavioural tests (voice-telegram twin of voice-phone's)

 for the PUT/GET /api/admin/config enum contract.

BAS-238 fixed `openai_voice` / `greeting_style` being validated by *length*
rather than *membership*, and deliberately split the write model
(`ConfigPayload`, enum-validated) from the read model (`ConfigResponse`, not
validated) so a legacy out-of-allowlist row stays visible instead of 500ing the
dashboard.

Until now that fix was covered only by a static guard plus a mutation audit.
These are the executed tests: they drive the real FastAPI app over HTTP through
the real repository code, with a minimal in-memory stand-in for the AsyncSession
so no Postgres is required.
"""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from voice_telegram.admin.models import AgentConfig
from voice_telegram.admin.routes import AVAILABLE_VOICES, GREETING_STYLES
from voice_telegram.api.dependencies import get_db_session
from voice_telegram.config import Settings
from voice_telegram.main import create_app

VALID_BODY: dict[str, Any] = {
    "agent_name": "Assistant",
    "agent_company": "Acme",
    "agent_prompt": "You are a helpful voice assistant.",
    "intro_prompt": "",
    "openai_voice": "marin",
    "max_call_seconds": 1800,
    "greeting_style": "casual",
    "custom_greeting": "",
    "vad_threshold": 0.5,
    "silence_duration_ms": 500,
}


class _FakeSession:
    """Just enough AsyncSession for AgentConfigRepository.

    `rows` is shared with the test so it can seed a legacy row and assert that
    a rejected PUT left the store untouched.
    """

    def __init__(self, rows: list[AgentConfig]) -> None:
        self.rows = rows

    async def scalar(self, _stmt: Any) -> AgentConfig | None:
        for row in self.rows:
            if row.is_active:
                return row
        return None

    def add(self, obj: AgentConfig) -> None:
        self.rows.append(obj)

    async def flush(self) -> None:
        return None

    async def commit(self) -> None:
        return None


def _make_client(rows: list[AgentConfig] | None = None) -> tuple[TestClient, list[AgentConfig]]:
    store: list[AgentConfig] = rows if rows is not None else []
    settings = Settings(
        admin_password="testpass",
        admin_jwt_secret="test-secret",
        public_base_url="http://testserver",
        
    )
    app = create_app(settings, start_telegram=False)
    app.state.settings = settings
    app.state.database = MagicMock()
    app.state.database.close = AsyncMock()

    async def _session_override() -> Any:
        yield _FakeSession(store)

    app.dependency_overrides[get_db_session] = _session_override
    client = TestClient(app)
    login = client.post("/api/admin/login", json={"password": "testpass"})
    assert login.status_code == 200, login.text
    client.cookies.set("admin_token", login.cookies["admin_token"])
    return client, store


def _row(**overrides: Any) -> AgentConfig:
    import uuid

    data: dict[str, Any] = {**VALID_BODY, "id": uuid.uuid4(), "is_active": True}
    data.update(overrides)
    return AgentConfig(**data)


def test_put_rejects_unknown_voice_and_leaves_the_row_unchanged() -> None:
    existing = _row(openai_voice="ash")
    client, store = _make_client([existing])

    resp = client.put("/api/admin/config", json={**VALID_BODY, "openai_voice": "nope"})

    assert resp.status_code == 422, resp.text
    assert "unknown voice" in resp.text
    # The write model rejected before the repository ran: nothing persisted.
    assert len(store) == 1
    assert store[0].openai_voice == "ash"


def test_put_rejects_unknown_greeting_style() -> None:
    client, store = _make_client([_row(greeting_style="casual")])

    resp = client.put("/api/admin/config", json={**VALID_BODY, "greeting_style": "shouty"})

    assert resp.status_code == 422, resp.text
    assert "unknown greeting style" in resp.text
    assert store[0].greeting_style == "casual"


def test_put_normalises_case_and_surrounding_whitespace() -> None:
    client, store = _make_client()

    resp = client.put("/api/admin/config", json={**VALID_BODY, "openai_voice": "ASH "})

    assert resp.status_code == 200, resp.text
    assert resp.json()["openai_voice"] == "ash"
    assert store[0].openai_voice == "ash"


# Vacuity floor. Parametrising only over AVAILABLE_VOICES / GREETING_STYLES
# derives the expectation from the thing under test: deleting an entry from
# either constant would silently delete a test case. These literals are the
# shipped contract -- the eleven ids the dashboard's Voice <select> renders
# from GET /voices, and the five options hard-coded in its Greeting Style
# <select> (voice-web/src/voice_web/static/index.html). Changing the product
# means changing this list deliberately.
SHIPPED_VOICE_IDS = frozenset(
    {
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "fable",
        "marin",
        "nova",
        "onyx",
        "sage",
        "shimmer",
        "verse",
    }
)
SHIPPED_GREETING_STYLES = frozenset(
    {"casual", "formal", "friendly", "professional", "custom"}
)


def test_allowlists_still_cover_the_shipped_dashboard_options() -> None:
    """Floor for the two parametrised tests below: if a voice or greeting style
    is dropped from the source constant, the parametrisation quietly shrinks
    and nothing fails. This catches that."""
    assert {v["id"] for v in AVAILABLE_VOICES} == SHIPPED_VOICE_IDS
    assert GREETING_STYLES == SHIPPED_GREETING_STYLES


@pytest.mark.parametrize("voice_id", sorted(SHIPPED_VOICE_IDS))
def test_every_advertised_voice_is_accepted_by_put(voice_id: str) -> None:
    """Pins the derived-allowlist contract: GET /voices and the write model
    cannot drift apart without this going red."""
    client, store = _make_client()

    resp = client.put("/api/admin/config", json={**VALID_BODY, "openai_voice": voice_id})

    assert resp.status_code == 200, f"{voice_id}: {resp.text}"
    assert store[0].openai_voice == voice_id


@pytest.mark.parametrize("style", sorted(SHIPPED_GREETING_STYLES))
def test_every_dashboard_greeting_style_is_accepted_by_put(style: str) -> None:
    client, _ = _make_client()

    resp = client.put("/api/admin/config", json={**VALID_BODY, "greeting_style": style})

    assert resp.status_code == 200, f"{style}: {resp.text}"


def test_voices_endpoint_matches_the_write_allowlist_exactly() -> None:
    client, _ = _make_client()
    served = {v["id"] for v in client.get("/api/admin/voices").json()}
    assert served == {v["id"] for v in AVAILABLE_VOICES}
    assert served == SHIPPED_VOICE_IDS


def test_get_config_still_serves_a_legacy_out_of_allowlist_row() -> None:
    """The regression the read/write model split exists to prevent.

    If ConfigResponse ever re-inherits the validators (or ConfigPayload is used
    as the response model), this returns 500 and the operator loses every route
    to seeing -- let alone correcting -- the bad value.
    """
    client, _ = _make_client([_row(openai_voice="legacy-bogus", greeting_style="legacy-style")])

    resp = client.get("/api/admin/config")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["openai_voice"] == "legacy-bogus"
    assert body["greeting_style"] == "legacy-style"
    assert body["source"] == "database"
