"""Attendant schemas — PIN never returned in any response."""
import re
from marshmallow import Schema, fields, validate, validates, ValidationError

from app.models.attendant import ShopRole


class AttendantSchema(Schema):
    id = fields.Int(dump_only=True)
    name = fields.Str(required=True, validate=validate.Length(min=2, max=100))
    shop_role = fields.Enum(ShopRole, by_value=True, load_default=ShopRole.attendant)
    active = fields.Bool(dump_default=True)
    # pin_hash is NEVER included in dump output
    # pin is WRITE-only (used when creating/resetting)
    pin = fields.Str(load_only=True, required=False)

    @validates("pin")
    def validate_pin(self, value):
        if not re.fullmatch(r"\d{4}", value):
            raise ValidationError("PIN must be exactly 4 digits.")


class LoginSchema(Schema):
    attendant_id = fields.Int(required=True)
    pin = fields.Str(required=True)

    @validates("pin")
    def validate_pin(self, value):
        if not re.fullmatch(r"\d{4}", value):
            raise ValidationError("PIN must be exactly 4 digits.")
