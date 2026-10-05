"""add PIN lockout columns to attendants

Revision ID: b7c8d9e0f1a2
Revises: 9c8d7e6f5a4b
Create Date: 2026-10-02 09:30:00.000000

4-digit PINs are brute-forceable, so login and verify-pin now count failures
per attendant and lock the account for a cool-down after repeated misses.
Existing rows start at 0 failures and unlocked.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b7c8d9e0f1a2'
down_revision = '9c8d7e6f5a4b'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('attendants', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('failed_pin_attempts', sa.Integer(), nullable=False, server_default='0')
        )
        batch_op.add_column(sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))


def downgrade():
    with op.batch_alter_table('attendants', schema=None) as batch_op:
        batch_op.drop_column('locked_until')
        batch_op.drop_column('failed_pin_attempts')
