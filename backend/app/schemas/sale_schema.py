"""Sale schemas."""
from marshmallow import Schema, fields, validate, validates, ValidationError

from app.models.sale import SyncStatus


class SaleSchema(Schema):
    """Full read schema for a Sale."""
    id = fields.Int(dump_only=True)
    client_uuid = fields.Str(required=True, validate=validate.Length(min=1, max=64))
    product_id = fields.Int(required=True)
    batch_id = fields.Int(dump_only=True)
    attendant_id = fields.Int(required=True)
    quantity_sold = fields.Float(required=True)
    unit_sold_in = fields.Str(
        required=True,
        validate=validate.OneOf(["kg", "piece", "litre"]),
    )
    price_charged = fields.Float(required=True)
    cost_at_sale = fields.Float(dump_only=True)
    profit = fields.Float(dump_only=True)
    sync_status = fields.Enum(SyncStatus, by_value=True, dump_only=True)
    created_at = fields.DateTime(required=True)
    synced_at = fields.DateTime(dump_only=True, allow_none=True)
    voided_at = fields.DateTime(dump_only=True, allow_none=True)
    voided_by = fields.Int(dump_only=True, allow_none=True)

    # Transaction grouping + historical snapshots (additive; NULL on legacy rows)
    sale_uuid = fields.Str(dump_only=True, allow_none=True)
    product_name_snapshot = fields.Str(dump_only=True, allow_none=True)
    button_label_snapshot = fields.Str(dump_only=True, allow_none=True)
    quantity_base = fields.Float(dump_only=True, allow_none=True)
    # Times the selling button was sold (count control). NULL on legacy rows.
    button_count_snapshot = fields.Int(dump_only=True, allow_none=True)

    # Convenience denormalisations for list views
    product_name = fields.Method("get_product_name", dump_only=True)
    attendant_name = fields.Method("get_attendant_name", dump_only=True)
    revenue = fields.Float(dump_only=True)
    margin_pct = fields.Float(dump_only=True)

    def get_product_name(self, obj):
        # Prefer the snapshot so history survives product renames.
        return obj.product_name_snapshot or (obj.product.name if obj.product else None)

    def get_attendant_name(self, obj):
        return obj.attendant.name if obj.attendant else None

    @validates("quantity_sold")
    def validate_qty(self, value):
        if value <= 0:
            raise ValidationError("quantity_sold must be > 0.")

    @validates("price_charged")
    def validate_price(self, value):
        if value < 0:
            raise ValidationError("price_charged must be >= 0.")


class SaleSyncItemSchema(Schema):
    """Schema for a single item inside POST /api/sales/sync payload."""
    client_uuid = fields.Str(required=True, validate=validate.Length(min=1, max=64))
    product_id = fields.Int(required=True)
    attendant_id = fields.Int(required=True)
    quantity_sold = fields.Float(required=True)
    unit_sold_in = fields.Str(
        required=True,
        validate=validate.OneOf(["kg", "piece", "litre"]),
    )
    price_charged = fields.Float(required=True)
    # Client-provided timestamp (ISO 8601)
    created_at = fields.DateTime(required=True)

    # Optional transaction grouping + selling-option metadata. Never used for
    # money math — the backend derives cost/profit from quantity/price/FIFO.
    sale_uuid = fields.Str(load_default=None, allow_none=True, validate=validate.Length(max=64))
    button_label = fields.Str(load_default=None, allow_none=True, validate=validate.Length(max=100))
    # Present when the line's selling option is a tracked amount (e.g. a
    # counted product's "3 tomatoes" bundle). Its presence routes the sale
    # through exact FIFO accounting; absence keeps legacy estimate behavior.
    amount_in_base_unit = fields.Float(load_default=None, allow_none=True)
    # How many times the selling button was sold (the till's count control).
    # Snapshotted for history; never used for money math (quantity_sold and
    # price_charged already carry the full accounting truth).
    count = fields.Int(load_default=None, allow_none=True, validate=validate.Range(min=1))

    @validates("quantity_sold")
    def validate_qty(self, value):
        if value <= 0:
            raise ValidationError("quantity_sold must be > 0.")

    @validates("price_charged")
    def validate_price(self, value):
        if value < 0:
            raise ValidationError("price_charged must be >= 0.")

    @validates("amount_in_base_unit")
    def validate_amount(self, value):
        if value is not None and value <= 0:
            raise ValidationError("amount_in_base_unit must be > 0.")
