"""StockBatch schemas."""
from marshmallow import Schema, fields, validate, validates, ValidationError

from app.models.stock_batch import BatchStatus


class StockBatchSchema(Schema):
    id = fields.Int(dump_only=True)
    product_id = fields.Int(required=True)
    bulk_quantity = fields.Float(required=True)
    bulk_unit = fields.Str(required=True, validate=validate.Length(min=1, max=50))
    total_cost = fields.Float(required=True)
    cost_per_base_unit = fields.Float(dump_only=True)
    quantity_remaining = fields.Float(dump_only=True)
    date_received = fields.DateTime(load_default=None, allow_none=True)
    status = fields.Enum(BatchStatus, by_value=True, dump_only=True)
    closed_at = fields.DateTime(dump_only=True, allow_none=True)

    # Batch-level P&L for 'counted' products: money in (total_cost) vs money
    # out (sum of sale prices rung against this batch).
    revenue_so_far = fields.Float(dump_only=True)
    profit_loss = fields.Float(dump_only=True)

    # For convenience in the list view
    product_name = fields.Method("get_product_name", dump_only=True)

    def get_product_name(self, obj):
        return obj.product.name if obj.product else None


class BatchCreateSchema(Schema):
    """Slimmer schema for POST /api/batches — only accepts writeable fields."""
    product_id = fields.Int(required=True)
    bulk_quantity = fields.Float(required=True)
    bulk_unit = fields.Str(required=True, validate=validate.Length(min=1, max=50))
    total_cost = fields.Float(required=True)
    date_received = fields.DateTime(load_default=None, allow_none=True)

    @validates("bulk_quantity")
    def validate_bulk_quantity(self, value):
        if value <= 0:
            raise ValidationError("bulk_quantity must be > 0.")

    @validates("total_cost")
    def validate_total_cost(self, value):
        if value < 0:
            raise ValidationError("total_cost must be >= 0.")
