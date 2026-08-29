from unittest.mock import AsyncMock, patch

import pytest

from voice_telegram.config import Settings
from voice_telegram.providers.base import RealtimeSession
from voice_telegram.providers.bridge import RealtimeBridge


@pytest.mark.asyncio
async def test_bridge_uses_exact_litellm_realtime_model() -> None:
    socket = AsyncMock()
    settings = Settings(
        litellm_base_url="http://litellm:4000",
        litellm_api_key="dedicated-key",
        litellm_realtime_model="litellm/realtime-main",
    )
    bridge = RealtimeBridge(
        settings,
        RealtimeSession(instructions="test", opening_message="hello"),
    )

    with patch(
        "voice_telegram.providers.bridge.connect", AsyncMock(return_value=socket)
    ) as connect:
        await bridge.connect()

    assert connect.await_args.args[0] == (
        "ws://litellm:4000/v1/realtime?model=litellm/realtime-main"
    )
    assert connect.await_args.kwargs["additional_headers"] == {
        "Authorization": "Bearer dedicated-key"
    }
