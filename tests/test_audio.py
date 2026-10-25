"""Tests for audio resampling utilities."""


from voice_telegram.audio import (
    OPENAI_CHUNK_BYTES,
    OPENAI_CHUNK_MS,
    OPENAI_SAMPLE_RATE,
    TELEGRAM_FRAME_BYTES,
    TELEGRAM_FRAME_MS,
    TELEGRAM_OUT_CHANNELS,
    TELEGRAM_SAMPLE_RATE,
    gate_noise_floor,
    resample_24k_to_48k_stereo,
    resample_48k_to_24k_mono,
    reset_resamplers,
)


def test_resample_48k_to_24k_mono() -> None:
    """Steady-state 48kHz mono -> 24kHz mono halves the byte count.

    ``StreamingResampler`` is a *streaming* soxr filter: it carries internal
    delay, so the first 20ms frame legitimately returns b"" while the filter
    primes. Asserting a per-frame length is therefore wrong (it was, and the
    test had never been executed). The contract that matters to the caller is
    the steady-state rate, so feed a second of audio and check the ratio.
    """
    reset_resamplers()
    frame = b"\x00\x01" * 480  # 20ms of 48kHz mono PCM16
    fed = 0
    produced = 0
    for _ in range(250):  # 5 seconds -- long enough to amortise the filter delay
        produced += len(resample_48k_to_24k_mono(frame))
        fed += len(frame)
    assert produced % 2 == 0, "output is not whole PCM16 samples"
    assert abs(produced / fed - 0.5) < 0.01, (fed, produced)


def test_resample_24k_to_48k_stereo() -> None:
    """Steady-state 24kHz mono -> 48kHz stereo is 4x the byte count.

    2x for the rate, 2x again for the channel duplication. Same streaming
    caveat as above: measure over a second, not over one primed-filter frame.
    """
    reset_resamplers()
    frame = b"\x00\x01" * 240  # 20ms of 24kHz mono PCM16
    fed = 0
    produced = 0
    for _ in range(250):
        produced += len(resample_24k_to_48k_stereo(frame))
        fed += len(frame)
    assert produced % 4 == 0, "output is not whole stereo PCM16 sample pairs"
    assert abs(produced / fed - 4.0) < 0.05, (fed, produced)


def test_resample_24k_to_48k_stereo_duplicates_the_channel() -> None:
    """Both channels must carry the same samples; a drifted interleave is audible."""
    reset_resamplers()
    out = b""
    for _ in range(250):
        out += resample_24k_to_48k_stereo(b"\x11\x22" * 240)
    assert out, "resampler produced nothing over a second of input"
    left = out[0::4] + out[1::4]
    right = out[2::4] + out[3::4]
    assert left == right


def test_empty_input_is_passed_through_without_priming_the_filter() -> None:
    reset_resamplers()
    assert resample_48k_to_24k_mono(b"") == b""
    assert resample_24k_to_48k_stereo(b"") == b""


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
    # OpenAI chunk: OPENAI_CHUNK_MS (100ms) at 24kHz, 16-bit mono = 4800 bytes.
    # Asserted against the derivation, not a magic number, so a deliberate
    # chunk-duration change does not need this test edited in lockstep.
    assert OPENAI_CHUNK_BYTES == OPENAI_SAMPLE_RATE * OPENAI_CHUNK_MS // 1000 * 2
    assert OPENAI_CHUNK_BYTES == 4800
    # Telegram frame: 20ms at 48kHz, 16-bit stereo = 3840 bytes.
    assert TELEGRAM_FRAME_BYTES == (
        TELEGRAM_SAMPLE_RATE * TELEGRAM_FRAME_MS // 1000 * TELEGRAM_OUT_CHANNELS * 2
    )
    assert TELEGRAM_FRAME_BYTES == 3840
