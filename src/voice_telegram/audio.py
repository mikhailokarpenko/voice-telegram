"""Audio processing utilities for Telegram voice agent.

Handles resampling between Telegram's 48kHz and OpenAI's 24kHz.
"""

import numpy as np
import soxr

# Audio constants
TELEGRAM_SAMPLE_RATE = 48000
TELEGRAM_OUT_CHANNELS = 2
TELEGRAM_FRAME_MS = 20
TELEGRAM_FRAME_BYTES = TELEGRAM_SAMPLE_RATE * TELEGRAM_FRAME_MS // 1000 * TELEGRAM_OUT_CHANNELS * 2  # 3840 bytes per frame (48kHz, 16-bit, stereo)

OPENAI_SAMPLE_RATE = 24000
OPENAI_CHUNK_MS = 100
OPENAI_CHUNK_BYTES = OPENAI_SAMPLE_RATE * OPENAI_CHUNK_MS // 1000 * 2  # 4800 bytes per chunk (24kHz, 16-bit, mono)


class StreamingResampler:
    def __init__(self, input_rate: int, output_rate: int) -> None:
        self._stream = soxr.ResampleStream(
            input_rate, output_rate, 1, dtype="int16", quality="HQ"
        )

    def process(self, pcm: bytes) -> bytes:
        if not pcm:
            return b""
        samples = np.frombuffer(pcm, dtype=np.int16).copy()
        output = self._stream.resample_chunk(samples)
        return output.astype(np.int16, copy=False).tobytes()


_input_resampler: StreamingResampler
_output_resampler: StreamingResampler


def resample_48k_to_24k_mono(pcm_48k: bytes) -> bytes:
    """Resample 48kHz mono PCM16 to 24kHz mono PCM16."""
    return _input_resampler.process(pcm_48k)


def resample_24k_to_48k_stereo(pcm_24k: bytes) -> bytes:
    """Resample 24kHz mono PCM16 to 48kHz stereo PCM16."""
    mono_48k = _output_resampler.process(pcm_24k)
    if not mono_48k:
        return b""
    mono = np.frombuffer(mono_48k, dtype=np.int16)
    stereo = np.empty(mono.size * 2, dtype=np.int16)
    stereo[0::2] = mono
    stereo[1::2] = mono
    return stereo.tobytes()


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
    """Reset streaming resampler state for a new call."""
    global _input_resampler, _output_resampler
    _input_resampler = StreamingResampler(TELEGRAM_SAMPLE_RATE, OPENAI_SAMPLE_RATE)
    _output_resampler = StreamingResampler(OPENAI_SAMPLE_RATE, TELEGRAM_SAMPLE_RATE)


reset_resamplers()
