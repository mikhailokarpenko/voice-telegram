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
- `ADMIN_PASSWORD`, `ADMIN_JWT_SECRET`: admin dashboard credentials. **Required
  when `ENVIRONMENT=production`** — `Settings` raises at startup if either is
  unset, and `ADMIN_JWT_SECRET` must be at least 32 characters. The secret must
  be stable across restarts and identical on every replica; it is no longer
  generated per process (a generated default silently invalidated all admin
  sessions on restart and broke admin auth behind a load balancer).

## Security guards

`node scripts/check-admin-config.mjs` (exit 0 = safe) statically asserts that
neither this service nor the sibling `voice-phone` repo reintroduces a
generated/random admin secret default, that both settings default to empty, that
the production fail-fast validator is present, and that `.env.example` documents
both variables. It runs in CI (`.github/workflows/ci.yml`) and needs Node only —
no Python or dependency install. When `voice-phone` is not present in the
checkout it is skipped; `voice-telegram` itself is always enforced.
