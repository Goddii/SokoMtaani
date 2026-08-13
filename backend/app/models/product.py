"""Product model."""
import enum
from datetime import datetime, timezone
from app.extensions import db


class BaseUnit(str, enum.Enum):
    kg = "kg"
    piece = "piece"
    litre = "litre"


class Category(str, enum.Enum):
    produce = "produce"
    dry = "dry"
    packaging = "packaging"


class PricingMode(str, enum.Enum):
    """How the product is priced and costed at the till.

    weighed — default: sold by weight/measure, exact kg accounting via FIFO
              batches (cost_per_base_unit, per-sale cost allocation).
    counted — sold by piece/bunch (tomatoes, garlic): no per-kg cost math.
              Each batch tracks its own P&L (total cost vs revenue rung
              against it); the till sells from fixed price buttons.
    """
    weighed = "weighed"
    counted = "counted"


class Product(db.Model):
    __tablename__ = "products"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False, unique=True)
    category = db.Column(db.Enum(Category), nullable=False)
    base_unit = db.Column(db.Enum(BaseUnit), nullable=False)

    # How this product is priced/costed: 'weighed' (default) or 'counted'
    pricing_mode = db.Column(db.Enum(PricingMode), nullable=False, default=PricingMode.weighed)

    # For items sold by piece but tracked in kg (e.g. tomatoes).
    # 1 piece ≈ avg_piece_weight kg
    avg_piece_weight = db.Column(db.Float, nullable=True)

    # Selling price per base unit (what the till charges)
    sell_price = db.Column(db.Float, nullable=False, default=0.0)

    # Cached from most-recent open batch — updated whenever a batch changes
    current_cost_per_unit = db.Column(db.Float, nullable=True)

    # Low-stock alert threshold in base_unit
    reorder_threshold = db.Column(db.Float, nullable=False, default=10.0)

    created_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    batches = db.relationship("StockBatch", back_populates="product", lazy="dynamic", order_by="StockBatch.date_received")
    sales = db.relationship("Sale", back_populates="product", lazy="dynamic")
    wastage_entries = db.relationship("Wastage", back_populates="product", lazy="dynamic")
    # Fixed-price buttons on the till — replaced wholesale on create/update.
    # 'weighed' buttons carry an exact kg_amount; 'counted' buttons don't.
    price_buttons = db.relationship(
        "PriceButton",
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="PriceButton.sort_order",
    )

    @property
    def total_stock(self) -> float:
        """Sum of quantity_remaining across all open batches (base_unit)."""
        from app.models.stock_batch import BatchStatus
        return sum(
            b.quantity_remaining
            for b in self.batches.filter_by(status=BatchStatus.open)
        )

    @property
    def is_low_stock(self) -> bool:
        return self.total_stock <= self.reorder_threshold

    def refresh_cost_cache(self):
        """Update current_cost_per_unit from the oldest open batch."""
        from app.models.stock_batch import BatchStatus
        oldest_open = (
            self.batches
            .filter_by(status=BatchStatus.open)
            .order_by("date_received")
            .first()
        )
        self.current_cost_per_unit = oldest_open.cost_per_base_unit if oldest_open else None

    def __repr__(self):
        return f"<Product {self.id} {self.name}>"
