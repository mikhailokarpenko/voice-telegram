"""Create telegram_calls table."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "telegram_calls",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("telegram_user_id", sa.String(length=64), nullable=False),
        sa.Column("direction", sa.String(length=16), server_default="inbound", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="created", nullable=False),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("context", JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_telegram_calls_status", "telegram_calls", ["status"])
    op.create_index("ix_telegram_calls_user_id", "telegram_calls", ["telegram_user_id"])


def downgrade() -> None:
    op.drop_index("ix_telegram_calls_user_id", table_name="telegram_calls")
    op.drop_index("ix_telegram_calls_status", table_name="telegram_calls")
    op.drop_table("telegram_calls")
