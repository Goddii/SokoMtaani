"""Wastage model — stock written off as spoilage, damage, etc."""
import enum
from datetime import datetime, timezone
from app.extensions import db


class WastageReason(str, enum.Enum):
    spoilage = "spoilage"
    damage = "damage"
    other = "other"


class Wastage(db.Model):
    __tablename__ = "wastage"

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)

    # Batch from which stock was deducted (FIFO-resolved)
    batch_id = db.Column(db.Integer, db.ForeignKey("stock_batches.id"), nullable=False)

    # Quantity in base_unit
    quantity = db.Column(db.Float, nullable=False)
    reason = db.Column(db.Enum(WastageReason), nullable=False, default=WastageReason.spoilage)

    date = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    recorded_by = db.Column(db.Integer, db.ForeignKey("attendants.id"), nullable=False)

    # Relationships
    product = db.relationship("Product", back_populates="wastage_entries")
    batch = db.relationship("StockBatch", back_populates="wastage_entries")
    recorded_by_attendant = db.relationship("Attendant", back_populates="wastage_entries")

    def __repr__(self):
        return f"<Wastage {self.id} product={self.product_id} qty={self.quantity}>"
