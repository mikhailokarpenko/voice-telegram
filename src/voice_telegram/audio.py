"""Audio processing utilities for Telegram voice agent.

Handles resampling between Telegram's 48kHz and OpenAI's 24kHz.
"""

import numpy as np
import soxr

# Audio constants
TELEGRAM_SAMPLE_RATE = 48000
TELEGRAM_OUT_CHANNELS = 2
TELEGRAM_FRAME_MS = 20
TELEGRAM_FRAME_BYTES = TELEGRAM_SAMPLE_RATE * TELEGRAM_FRAME_MS // 1000 * 2  # 960 bytes per frame (48kHz, 16-bit, mono)

OPENAI_SAMPLE_RATE = 24000
OPENAI_CHUNK_MS = 100
OPENAI_CHUNK_BYTES = OPENAI_SAMPLE_RATE * OPENAI_CHUNK_MS // 1000 * 2  # 4800 bytes per chunk (24kHz, 16-bit, mono)


def resample_48k_to_24k_mono(pcm_48k: bytes) -> bytes:
    """Resample 48kHz mono PCM16 to 24kHz mono PCM16."""
    if not pcm_48k:
        return b""
    arr = np.frombuffer(pcm_48k, dtype=np.int16)
    resampled = soxr.resample(
        arr,
        TELEGRAM_SAMPLE_RATE,
        OPENAI_SAMPLE_RATE,
        quality="HQ",
    )
    return resampled.astype(np.int16).tobytes()


def resample_24k_to_48k_stereo(pcm_24k: bytes) -> bytes:
    """Resample 24kHz mono PCM16 to 48kHz stereo PCM16."""
    if not pcm_24k:
        return b""
    arr = np.frombuffer(pcm_24k, dtype=np.int16)
    resampled = soxr.resample(
        arr,
        OPENAI_SAMPLE_RATE,
        TELEGRAM_SAMPLE_RATE,
        quality="HQ",
    )
    # Convert mono to stereo by duplicating channels
    stereo = np.column_stack((resampled, resampled))
    return stereo.astype(np.int16).tobytes()


def gate_noise_floor(pcm: bytes, rms_threshold: float) -> bytes:
    """Drop audio frames below RMS threshold to reduce background noise."""
    if rms_threshold <= 0:
        return pcm
    arr = np.frombuffer(pcm, dtype=np.int16)
    rms = np.sqrt(np.mean(arr.astype(np.float32) ** 2))
    if rms < rms_threshold:
        return b"\x00" * len(pcm)
    return pcm


def reset_resamplers() -> None:
    """Reset any resampler state (placeholder for soxr state if needed)."""
    pass
