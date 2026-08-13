"""Sale model — one line item per sale (one product per record)."""
import enum
from datetime import datetime, timezone
from app.extensions import db


class SyncStatus(str, enum.Enum):
    pending = "pending"
    synced = "synced"


class Sale(db.Model):
    __tablename__ = "sales"

    # Server-generated primary key
    id = db.Column(db.Integer, primary_key=True)

    # Phone-generated UUID for offline deduplication
    client_uuid = db.Column(db.String(64), nullable=False, unique=True, index=True)

    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)

    # Resolved FIFO at sync time
    batch_id = db.Column(db.Integer, db.ForeignKey("stock_batches.id"), nullable=False)

    attendant_id = db.Column(db.Integer, db.ForeignKey("attendants.id"), nullable=False, index=True)

    quantity_sold = db.Column(db.Float, nullable=False)
    unit_sold_in = db.Column(db.String(20), nullable=False)  # piece / kg / litre

    price_charged = db.Column(db.Float, nullable=False)  # KES per unit_sold_in

    # Snapshot at sale time — never recalculated later
    cost_at_sale = db.Column(db.Float, nullable=False)

    # Stored profit: (price_charged - cost_at_sale) * quantity_sold_in_base_unit
    profit = db.Column(db.Float, nullable=False)

    sync_status = db.Column(db.Enum(SyncStatus), nullable=False, default=SyncStatus.synced)

    # Client-provided timestamp (when the sale happened on the phone)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False)

    # Server timestamp (when we processed it)
    synced_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    # Void — null unless the sale has been voided (row is kept, stock restored)
    voided_at = db.Column(db.DateTime(timezone=True), nullable=True)
    voided_by = db.Column(db.Integer, db.ForeignKey("attendants.id"), nullable=True)

    # Exact FIFO restore map for voids: [{"batch_id": int, "qty": float}] in
    # base_unit. A single sale can consume from several batches (FIFO walks
    # oldest-first), and voiding must put each unit back on the batch that
    # actually supplied it — otherwise the first batch gets over-credited and
    # later batches never recover their share, silently skewing future FIFO
    # cost/margin. Null for legacy counted sales (they never deduct) and for
    # sales recorded before this column existed (they fall back to restoring
    # the whole quantity to the recorded batch).
    batch_allocations = db.Column(db.JSON, nullable=True)

    # Transaction-level id (the phone's cart id) — groups the line rows that
    # made up one checkout into a single transaction on the Sales screen.
    # NULL on rows recorded before this column existed; those group by their
    # client_uuid prefix instead.
    sale_uuid = db.Column(db.String(64), nullable=True, index=True)

    # Snapshots taken at sync time so history survives later product edits.
    product_name_snapshot = db.Column(db.String(200), nullable=True)
    button_label_snapshot = db.Column(db.String(100), nullable=True)

    # How many times the selling button was sold (the till's count control,
    # e.g. "1 tomato @ KSh5" x3). NULL on legacy rows and flat-rate lines.
    # Kept separate from quantity_base so history can show "3 × 1 tomato"
    # (count 3, button amount 1) rather than collapsing it into the button's
    # amount — and so a void/report never has to re-derive the count from
    # today's button configuration.
    button_count_snapshot = db.Column(db.Integer, nullable=True)

    # Base-unit amount actually consumed from stock (FIFO). NULL for legacy
    # counted sales that never deducted. Lets a void restore exactly without
    # re-deriving conversions from today's product configuration.
    quantity_base = db.Column(db.Float, nullable=True)

    # Relationships
    product = db.relationship("Product", back_populates="sales")
    batch = db.relationship("StockBatch", back_populates="sales")
    # foreign_keys disambiguates the join — sales has two FKs to attendants
    # (attendant_id, voided_by).
    attendant = db.relationship(
        "Attendant",
        back_populates="sales",
        foreign_keys=[attendant_id],
    )

    @property
    def revenue(self) -> float:
        return self.price_charged * self.quantity_sold

    @property
    def margin_pct(self) -> float:
        """Gross margin as a fraction (0–1)."""
        rev = self.revenue
        return self.profit / rev if rev else 0.0

    def __repr__(self):
        return f"<Sale {self.id} uuid={self.client_uuid}>"
