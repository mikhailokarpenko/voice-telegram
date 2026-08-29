"""Create agent_configs table."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_name", sa.String(128), nullable=False),
        sa.Column("agent_company", sa.String(128), nullable=False),
        sa.Column("agent_prompt", sa.Text(), nullable=False),
        sa.Column("intro_prompt", sa.Text(), nullable=False),
        sa.Column("openai_voice", sa.String(32), nullable=False),
        sa.Column("max_call_seconds", sa.Integer(), nullable=False),
        sa.Column("greeting_style", sa.String(32), nullable=False),
        sa.Column("custom_greeting", sa.Text(), nullable=False),
        sa.Column("vad_threshold", sa.Float(), nullable=False),
        sa.Column("silence_duration_ms", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_configs_is_active", "agent_configs", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_agent_configs_is_active", table_name="agent_configs")
    op.drop_table("agent_configs")
