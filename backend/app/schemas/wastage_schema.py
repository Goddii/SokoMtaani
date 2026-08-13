"""Wastage schemas."""
from marshmallow import EXCLUDE, Schema, fields, validate, validates, ValidationError

from app.models.wastage import WastageReason


class WastageSchema(Schema):
    id = fields.Int(dump_only=True)
    product_id = fields.Int(required=True)
    batch_id = fields.Int(dump_only=True)
    quantity = fields.Float(required=True)
    reason = fields.Enum(WastageReason, by_value=True, load_default=WastageReason.spoilage)
    date = fields.DateTime(load_default=None, allow_none=True)
    recorded_by = fields.Int(required=True)

    # Read-only denormalisations
    product_name = fields.Method("get_product_name", dump_only=True)
    attendant_name = fields.Method("get_attendant_name", dump_only=True)

    def get_product_name(self, obj):
        return obj.product.name if obj.product else None

    def get_attendant_name(self, obj):
        return obj.recorded_by_attendant.name if obj.recorded_by_attendant else None


class WastageCreateSchema(Schema):
    """Writeable-only fields for POST /api/wastage.

    recorded_by is intentionally absent — the acting attendant is derived from
    the JWT identity server-side, never trusted from the client. Any stray
    client field (e.g. a stale recorded_by) is silently dropped.
    """
    product_id = fields.Int(required=True)
    quantity = fields.Float(required=True)
    reason = fields.Enum(WastageReason, by_value=True, load_default=WastageReason.spoilage)
    date = fields.DateTime(load_default=None, allow_none=True)

    class Meta:
        unknown = EXCLUDE

    @validates("quantity")
    def validate_quantity(self, value):
        if value <= 0:
            raise ValidationError("quantity must be > 0.")
