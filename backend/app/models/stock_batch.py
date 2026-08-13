"""StockBatch model — tracks a single bulk purchase of a product."""
import enum
from datetime import datetime, timezone
from app.extensions import db


class BatchStatus(str, enum.Enum):
    open = "open"
    closed = "closed"


class StockBatch(db.Model):
    __tablename__ = "stock_batches"

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)

    # How it was purchased (e.g. 2 bags of 50 kg each)
    bulk_quantity = db.Column(db.Float, nullable=False)
    bulk_unit = db.Column(db.String(50), nullable=False)  # e.g. "bag", "crate", "kg"
    total_cost = db.Column(db.Float, nullable=False)  # KES

    # Computed on insert: total_cost / (bulk_quantity in base_unit)
    cost_per_base_unit = db.Column(db.Float, nullable=False)

    # Decrements as sales / wastage consume this batch
    quantity_remaining = db.Column(db.Float, nullable=False)

    date_received = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    status = db.Column(db.Enum(BatchStatus), nullable=False, default=BatchStatus.open, index=True)
    closed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    # Relationships
    product = db.relationship("Product", back_populates="batches")
    sales = db.relationship("Sale", back_populates="batch", lazy="dynamic")
    wastage_entries = db.relationship("Wastage", back_populates="batch", lazy="dynamic")

    def close_if_empty(self):
        """Auto-close this batch if quantity_remaining hits 0."""
        if self.quantity_remaining <= 0:
            self.quantity_remaining = 0
            self.status = BatchStatus.closed
            self.closed_at = datetime.now(timezone.utc)

    @property
    def revenue_so_far(self) -> float:
        """KES rung against this batch: sum of price_charged * quantity_sold.

        Only meaningful for 'counted' products — it's the "money out" side of
        the batch-level P&L (vs total_cost, the "money in"). Voided sales are
        excluded. Harmless for 'weighed' batches, where sales are costed
        per-unit instead.
        """
        return sum(
            s.price_charged * s.quantity_sold
            for s in self.sales
            if not s.voided_at
        )

    @property
    def profit_loss(self) -> float:
        """Batch-level P&L for 'counted' products: revenue_so_far - total_cost."""
        return self.revenue_so_far - self.total_cost

    def __repr__(self):
        return f"<StockBatch {self.id} product={self.product_id} remaining={self.quantity_remaining}>"
