"""add button count snapshot — the till's count control survives history

Revision ID: 9c8d7e6f5a4b
Revises: f2e3d4c5b6a7
Create Date: 2026-08-13 09:00:00.000000

The POS count control sells a price button N times (e.g. "1 tomato @ KSh5"
x3). quantity_base already records the base-unit amount actually consumed,
but reconstructing "3 × 1 tomato" (count 3, button amount 1) from it requires
the button's amount — which lives in the current product config and can
change. This nullable column snapshots the count at sync time so the Sales
screen can always show the exact button sale without re-deriving it.

NULL on legacy rows and flat-rate lines. No backfill — old rows simply have
no count to display.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '9c8d7e6f5a4b'
down_revision = 'f2e3d4c5b6a7'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.add_column(sa.Column('button_count_snapshot', sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.drop_column('button_count_snapshot')
