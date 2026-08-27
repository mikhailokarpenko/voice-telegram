"""Tests for audio resampling utilities."""

import pytest

from voice_telegram.audio import (
    OPENAI_CHUNK_BYTES,
    TELEGRAM_FRAME_BYTES,
    gate_noise_floor,
    resample_24k_to_48k_stereo,
    resample_48k_to_24k_mono,
)


def test_resample_48k_to_24k_mono() -> None:
    """Test resampling from 48kHz mono to 24kHz mono."""
    # Create 960 bytes of 48kHz mono PCM (20ms at 48kHz * 2 bytes/sample)
    input_data = b"\x00\x01" * 480
    output = resample_48k_to_24k_mono(input_data)
    # Should be 480 bytes (20ms at 24kHz * 2 bytes/sample)
    assert len(output) == 480


def test_resample_24k_to_48k_stereo() -> None:
    """Test resampling from 24kHz mono to 48kHz stereo."""
    # Create 480 bytes of 24kHz mono PCM (20ms at 24kHz * 2 bytes/sample)
    input_data = b"\x00\x01" * 240
    output = resample_24k_to_48k_stereo(input_data)
    # Should be 1920 bytes (20ms at 48kHz * 2 channels * 2 bytes/sample)
    assert len(output) == 1920


def test_gate_noise_floor() -> None:
    """Test noise gating."""
    # Create some audio data
    input_data = b"\x00\x01" * 100
    # With threshold 0, should pass through
    output = gate_noise_floor(input_data, 0)
    assert output == input_data

    # With high threshold, should zero out
    output = gate_noise_floor(input_data, 1000)
    assert output == b"\x00\x00" * 100


def test_constants() -> None:
    """Test audio constants."""
    # OpenAI chunk: 480 samples at 24kHz * 2 bytes = 960 bytes
    assert OPENAI_CHUNK_BYTES == 960
    # Telegram frame: 960 samples at 48kHz * 2 channels * 2 bytes = 3840 bytes
    assert TELEGRAM_FRAME_BYTES == 3840
