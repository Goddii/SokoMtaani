"""add sale accounting snapshots — transaction grouping + historical integrity

Revision ID: f2e3d4c5b6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-08-12 12:00:00.000000

A completed sale must remain reconstructable even if the product is later
edited. This adds the minimum additive snapshot information:

- sale_uuid:          the phone's cart id — groups the line rows that made up
                      one checkout into a transaction on the Sales screen.
- product_name_snapshot: the product name at sync time, so history survives
                      renames.
- button_label_snapshot: the selling option's label (e.g. "1/4 kg",
                      "3 @ KSh10"), so history survives button edits.
- quantity_base:      the base-unit amount actually consumed from stock (FIFO).
                      NULL for legacy counted sales that never deducted. Lets a
                      void restore exactly without re-deriving conversions
                      from today's product config.

All columns are nullable and NOT backfilled: historical rows keep their
existing display behavior (fall back to the current product/name or the
client_uuid prefix for grouping).
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f2e3d4c5b6a7'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.add_column(sa.Column('sale_uuid', sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column('product_name_snapshot', sa.String(length=200), nullable=True))
        batch_op.add_column(sa.Column('button_label_snapshot', sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column('quantity_base', sa.Float(), nullable=True))
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_sales_sale_uuid'), ['sale_uuid'], unique=False)


def downgrade():
    with op.batch_alter_table('sales', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_sales_sale_uuid'))
        batch_op.drop_column('sale_uuid')
        batch_op.drop_column('product_name_snapshot')
        batch_op.drop_column('button_label_snapshot')
        batch_op.drop_column('quantity_base')
