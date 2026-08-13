"""Product schemas."""
from marshmallow import Schema, fields, validate, validates, validates_schema, ValidationError

from app.models.product import BaseUnit, Category, PricingMode


class PriceButtonSchema(Schema):
    """A fixed-price button on the till."""
    id = fields.Int(dump_only=True)
    label = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    # Exact amount of the product's base unit — required for 'weighed'
    # products, must stay null for 'counted' (sold by piece) products.
    kg_amount = fields.Float(allow_none=True, load_default=None)
    # Fixed KES price charged for this button
    price = fields.Float(required=True)
    # Optional — the route falls back to the button's position in the list
    sort_order = fields.Int()

    @validates("kg_amount")
    def validate_kg_amount(self, value):
        if value is not None and value <= 0:
            raise ValidationError("kg_amount must be > 0 when set.")

    @validates("price")
    def validate_price(self, value):
        if value < 0:
            raise ValidationError("price must be >= 0.")


class ProductSchema(Schema):
    id = fields.Int(dump_only=True)
    name = fields.Str(required=True, validate=validate.Length(min=1, max=200))
    category = fields.Enum(Category, by_value=True, required=True)
    base_unit = fields.Enum(BaseUnit, by_value=True, required=True)
    # 'weighed' (default) or 'counted' — how the till prices/costs this product
    pricing_mode = fields.Enum(PricingMode, by_value=True, load_default=PricingMode.weighed)
    avg_piece_weight = fields.Float(load_default=None, allow_none=True)
    sell_price = fields.Float(load_default=0.0)
    current_cost_per_unit = fields.Float(dump_only=True, allow_none=True)
    reorder_threshold = fields.Float(load_default=10.0)
    created_at = fields.DateTime(dump_only=True)

    # Fixed-price buttons — accepted on create/update, dumped on read
    price_buttons = fields.Nested(PriceButtonSchema, many=True)

    # Computed fields (dump only)
    total_stock = fields.Float(dump_only=True)
    is_low_stock = fields.Bool(dump_only=True)

    @validates_schema
    def validate_buttons_vs_mode(self, data, **kwargs):
        """
        The button amount is the amount of the product's base unit the option
        consumes from stock:
        - 'counted' buttons MAY carry an amount (pieces) — NULL means a legacy
          untracked estimate option.
        - 'weighed' buttons must have kg_amount > 0 (an exact amount).
        Only enforced when both fields are present in the payload (routes
        re-check for partial updates).
        """
        buttons = data.get("price_buttons")
        if not buttons:
            return
        mode = data.get("pricing_mode")
        if mode is None:
            return
        if mode == PricingMode.counted:
            return  # counted amounts are optional (legacy compatibility)
        bad = [b for b in buttons if b.get("kg_amount") is None]
        if bad:
            raise ValidationError(
                "Each price button for a weighed product needs a kg_amount "
                "(the exact amount it represents)."
            )

    @validates("sell_price")
    def validate_sell_price(self, value):
        if value < 0:
            raise ValidationError("sell_price must be >= 0.")

    @validates("reorder_threshold")
    def validate_threshold(self, value):
        if value < 0:
            raise ValidationError("reorder_threshold must be >= 0.")

    @validates("avg_piece_weight")
    def validate_avg_piece_weight(self, value):
        if value is not None and value <= 0:
            raise ValidationError("avg_piece_weight must be > 0.")
