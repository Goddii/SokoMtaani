"""add pricing_mode + price_buttons, migrate & drop price_tiers

Revision ID: e7f8a9b0c1d2
Revises: d5e6f7a8b9c0
Create Date: 2026-08-07 10:00:00.000000

Replaces the one-off price_tiers concept with the unified price_buttons
model (label + optional kg_amount + price) plus the product.pricing_mode
enum. Any existing price_tier rows are migrated into price_buttons with
kg_amount = kg_equivalent.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e7f8a9b0c1d2'
down_revision = 'd5e6f7a8b9c0'
branch_labels = None
depends_on = None


def upgrade():
    #explicitly create the Postgres ENUM type first
    pricing_mode_enum = sa.Enum('weighed', 'counted', name='pricingmode')
    pricing_mode_enum.create(op.get_bind(), checkfirst=True)
    # pricing_mode on products — default 'weighed', every existing product keeps it
    op.add_column(
        'products',
        sa.Column('pricing_mode', pricing_mode_enum, server_default='weighed', nullable=False),
    )

    # New unified price_buttons table
    op.create_table(
        'price_buttons',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('product_id', sa.Integer(), nullable=False),
        sa.Column('label', sa.String(length=100), nullable=False),
        sa.Column('kg_amount', sa.Numeric(precision=10, scale=3), nullable=True),
        sa.Column('price', sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['product_id'], ['products.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_price_buttons_product_id'), 'price_buttons', ['product_id'])

    # Migrate any existing tier data into price_buttons (kg_equivalent -> kg_amount)
    op.execute("""
        INSERT INTO price_buttons (product_id, label, kg_amount, price, sort_order)
        SELECT product_id, label, kg_equivalent, price, sort_order FROM price_tiers
    """)

    # Drop the superseded price_tiers table
    op.drop_index(op.f('ix_price_tiers_product_id'), table_name='price_tiers')
    op.drop_table('price_tiers')


def downgrade():
    # Recreate price_tiers and move the weighed-style buttons back
    op.create_table(
        'price_tiers',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('product_id', sa.Integer(), nullable=False),
        sa.Column('label', sa.String(length=100), nullable=False),
        sa.Column('kg_equivalent', sa.Numeric(precision=10, scale=3), nullable=False),
        sa.Column('price', sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['product_id'], ['products.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_price_tiers_product_id'), 'price_tiers', ['product_id'])

    # Counted buttons have no kg_amount — only weighed-style rows move back
    op.execute("""
        INSERT INTO price_tiers (product_id, label, kg_equivalent, price, sort_order)
        SELECT product_id, label, kg_amount, price, sort_order FROM price_buttons
        WHERE kg_amount IS NOT NULL
    """)

    op.drop_index(op.f('ix_price_buttons_product_id'), table_name='price_buttons')
    op.drop_table('price_buttons')

    with op.batch_alter_table('products', schema=None) as batch_op:
        batch_op.drop_column('pricing_mode')

    # Drop the ENUM type if no other columns are using it
    sa.Enum(name='pricingmode').drop(op.get_bind(), checkfirst=True)    
