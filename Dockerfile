FROM python:3.12.10-slim AS runtime

# Install system dependencies for audio processing and PyTgCalls
RUN apt-get update && apt-get install -y \
    libsoxr-dev \
    libopus-dev \
    libavdevice-dev \
    libavutil-dev \
    libswresample-dev \
    libvpx-dev \
    libx264-dev \
    ffmpeg \
    gcc \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system voice_telegram || true && \
    useradd --system --gid voice_telegram --create-home voice_telegram || true
WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
COPY alembic.ini ./
COPY migrations ./migrations
# gcc and the headers above are present in this image, so the TgCrypto speedup
# compiles here even though it has no 3.12 wheel. Production keeps it; the test
# install deliberately does not (see pyproject.toml).
RUN pip install --no-cache-dir '.[speedups]'

# Session files are supplied at runtime via a bind mount (see compose.yaml),
# never baked into the image.
RUN mkdir -p /app/sessions && chown -R voice_telegram:voice_telegram /app/sessions

USER voice_telegram
CMD ["python", "-m", "voice_telegram.main"]
