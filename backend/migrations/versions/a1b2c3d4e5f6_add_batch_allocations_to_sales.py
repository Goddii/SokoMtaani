"""add batch_allocations to sales — exact FIFO restore map for voids

Revision ID: a1b2c3d4e5f6
Revises: e7f8a9b0c1d2
Create Date: 2026-08-11 16:30:00.000000

A single sale can consume from several batches (FIFO walks oldest-first), but
the Sale row only ever recorded the first batch. Voiding then over-credited
that first batch and never recovered the later batches' share. This column
stores the exact per-batch deduction map so a void can restore each unit to
the batch that actually supplied it.

The column is nullable and NOT backfilled: sales recorded before this
migration keep voiding exactly as they always did (restore everything to the
recorded batch). No historical rows are rewritten.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = 'e7f8a9b0c1d2'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.add_column(sa.Column('batch_allocations', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.drop_column('batch_allocations')
