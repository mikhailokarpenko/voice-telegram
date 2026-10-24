"""Tests for main.py startup behavior."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI

from voice_telegram.main import create_app


async def test_startup_assertion_on_telegram_start_failure() -> None:
    """Test that startup fails loudly when telegram.start() raises an exception."""
    mock_settings = MagicMock()
    mock_settings.database_url = "postgresql+asyncpg://test:test@localhost/test"
    mock_settings.public_base_url = "http://localhost:8000"

    with patch("voice_telegram.main.get_settings", return_value=mock_settings):
        with patch("voice_telegram.main.Database") as MockDatabase:
            mock_database = AsyncMock()
            MockDatabase.return_value = mock_database

            with patch("voice_telegram.main.TelegramVoiceClient") as MockClient:
                mock_client = AsyncMock()
                mock_client.start.side_effect = Exception("Telegram auth failed")
                MockClient.return_value = mock_client

                # Mock sys.exit to capture the exit call
                with patch("voice_telegram.main.sys.exit") as mock_exit:
                    # Create the app with start_telegram=True (default)
                    app = create_app(mock_settings, start_telegram=True)

                    # Trigger lifespan startup - should raise SystemExit
                    with pytest.raises(SystemExit):
                        async with router_lifespan_context(app):
                            pass

                    # Verify sys.exit was called with code 1
                    mock_exit.assert_called_once_with(1)


async def test_startup_succeeds_on_telegram_start_success() -> None:
    """Test that startup succeeds normally when telegram.start() succeeds."""
    mock_settings = MagicMock()
    mock_settings.database_url = "postgresql+asyncpg://test:test@localhost/test"
    mock_settings.public_base_url = "http://localhost:8000"

    with patch("voice_telegram.main.get_settings", return_value=mock_settings):
        with patch("voice_telegram.main.Database") as MockDatabase:
            mock_database = AsyncMock()
            mock_database.session = MagicMock()
            MockDatabase.return_value = mock_database

            with patch("voice_telegram.main.TelegramVoiceClient") as MockClient:
                mock_client = AsyncMock()
                MockClient.return_value = mock_client

                # Create the app with start_telegram=True
                app = create_app(mock_settings, start_telegram=True)

                # Trigger lifespan startup - should not call sys.exit
                with patch("voice_telegram.main.sys.exit") as mock_exit:
                    async with router_lifespan_context(app):
                        # Verify sys.exit was NOT called
                        mock_exit.assert_not_called()

                    # Verify telegram.start() was called
                    mock_client.start.assert_called_once()

                    # Verify telegram.stop() was called during shutdown
                    mock_client.stop.assert_called_once()


async def test_startup_skips_telegram_when_start_telegram_false() -> None:
    """Test that startup skips Telegram initialization when start_telegram=False."""
    mock_settings = MagicMock()
    mock_settings.database_url = "postgresql+asyncpg://test:test@localhost/test"
    mock_settings.public_base_url = "http://localhost:8000"

    with patch("voice_telegram.main.get_settings", return_value=mock_settings):
        with patch("voice_telegram.main.Database") as MockDatabase:
            mock_database = AsyncMock()
            MockDatabase.return_value = mock_database

            with patch("voice_telegram.main.TelegramVoiceClient") as MockClient:
                mock_client = AsyncMock()
                MockClient.return_value = mock_client

                # Create the app with start_telegram=False
                app = create_app(mock_settings, start_telegram=False)

                # Trigger lifespan startup
                with patch("voice_telegram.main.sys.exit") as mock_exit:
                    async with router_lifespan_context(app):
                        # Verify sys.exit was NOT called
                        mock_exit.assert_not_called()

                    # Verify telegram.start() was NOT called
                    mock_client.start.assert_not_called()

                    # Verify telegram.stop() was NOT called
                    mock_client.stop.assert_not_called()


def router_lifespan_context(app: FastAPI):
    """Helper to run the FastAPI app's lifespan context."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _lifespan_wrapper():
        async with app.router.lifespan_context(app):
            yield

    return _lifespan_wrapper()
