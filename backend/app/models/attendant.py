"""Attendant model — shop staff and owner."""
import enum
from app.extensions import db


class ShopRole(str, enum.Enum):
    attendant = "attendant"
    owner = "owner"


class Attendant(db.Model):
    __tablename__ = "attendants"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    pin_hash = db.Column(db.String(255), nullable=False)
    shop_role = db.Column(db.Enum(ShopRole), nullable=False, default=ShopRole.attendant)
    active = db.Column(db.Boolean, nullable=False, default=True)

    # Relationships
    sales = db.relationship(
        "Sale",
        back_populates="attendant",
        foreign_keys="Sale.attendant_id",
        lazy="dynamic",
    )
    wastage_entries = db.relationship("Wastage", back_populates="recorded_by_attendant", lazy="dynamic")

    def __repr__(self):
        return f"<Attendant {self.id} {self.name} ({self.shop_role.value})>"
