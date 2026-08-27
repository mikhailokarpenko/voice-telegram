FROM python:3.12.10-slim AS runtime

# Install system dependencies for audio processing
RUN apt-get update && apt-get install -y \
    libsoxr-dev \
    libopus-dev \
    libavdevice-dev \
    libavutil-dev \
    libswresample-dev \
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
COPY voice_telegram_session.session ./
RUN pip install --no-cache-dir .

# Create directory for session files with proper permissions
RUN mkdir -p /app/sessions && chown -R voice_telegram:voice_telegram /app/sessions

# Copy session file to sessions directory
RUN cp voice_telegram_session.session /app/sessions/ && chown voice_telegram:voice_telegram /app/sessions/voice_telegram_session.session

USER voice_telegram
CMD ["python", "-m", "voice_telegram.main"]
