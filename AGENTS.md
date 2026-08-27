# Voice Telegram Agent

## Development

### Environment Setup

The project uses `uv` for dependency management. Install dependencies:

```bash
uv sync --dev
```

### Running Tests

```bash
uv run pytest
```

### Linting

```bash
uv run ruff check .
uv run ruff format --check .
```

### Type Checking

```bash
uv run mypy src/
```

### Database Migrations

```bash
uv run alembic upgrade head
```

### Running the Agent

```bash
# Copy example env and configure
cp .env.example .env
# Edit .env with your credentials

# Run with uv
uv run python -m voice_telegram.main

# Or with Docker
docker compose up --build
```

## Architecture

- **Audio Pipeline**: Resamples between Telegram's 48kHz stereo and OpenAI's 24kHz mono
- **Telegram Client**: Uses Pyrogram + PyTgCalls for voice calls
- **OpenAI Bridge**: WebSocket connection to OpenAI Realtime API
- **Database**: PostgreSQL with SQLAlchemy async ORM
- **Calls Model**: Tracks call status, duration, and transcripts

## Configuration

See `.env.example` for required environment variables:
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE`: Telegram userbot credentials
- `OPENAI_API_KEY`: OpenAI API key
- `DATABASE_URL`: PostgreSQL connection string
