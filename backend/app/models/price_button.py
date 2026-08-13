"""PriceButton model — a fixed-price button on the till for a product.

Used by BOTH pricing modes:

- 'weighed' products (rice, sugar): a button is an exact amount of the base
  unit sold at a fixed price, e.g. "1/4 kg" → kg_amount=0.25, price=65. The
  POS logs it through the normal FIFO path with quantity_sold = kg_amount and
  price_charged = price / kg_amount, so cost/profit math stays exact.
- 'counted' products (tomatoes, garlic): a button is just a label + fixed
  price, e.g. "1 @ KSh5" or "3 @ KSh20". kg_amount stays NULL. The POS logs a
  sale at quantity_sold=1, price_charged = the button's price, with no
  per-unit cost allocation — profit lives at the batch level.
"""
from app.extensions import db


class PriceButton(db.Model):
    __tablename__ = "price_buttons"

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(
        db.Integer,
        db.ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Display label on the till, e.g. "1/4 kg", "1 @ KSh5", "Big (1)"
    label = db.Column(db.String(100), nullable=False)

    # Exact amount of the product's base unit this button represents.
    # Required for 'weighed' products, always NULL for 'counted' products.
    kg_amount = db.Column(db.Numeric(10, 3), nullable=True)

    # The fixed KES price the customer pays for this button
    price = db.Column(db.Numeric(10, 2), nullable=False)

    # Display order within the product's button list
    sort_order = db.Column(db.Integer, nullable=False, default=0)

    # Relationships
    product = db.relationship("Product", back_populates="price_buttons")

    def __repr__(self):
        return f"<PriceButton {self.id} {self.label} KES {self.price}>"
