"""
Per-line processing for POST /api/sales/sync, plus the FIFO stock helpers
shared with the void and wastage routes.

Each sync line is independent: it either becomes a durable Sale (committed on
its own) or is rejected with a reason. Lines already reported "synced" are
therefore safe for the client to drop from its offline queue.

KES precision: price_charged, quantity_sold, cost_at_sale and profit stay at
FULL float precision here — rounding happens only at serialisation (see the
invariant in app/routes/sales.py).
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from marshmallow import ValidationError

from app.extensions import db
from app.models.attendant import Attendant
from app.models.product import Product, PricingMode
from app.models.sale import Sale, SyncStatus
from app.models.stock_batch import StockBatch, BatchStatus
from app.schemas.sale_schema import SaleSyncItemSchema
from app.utils.unit_conversion import to_base_unit

logger = logging.getLogger(__name__)

sync_item_schema = SaleSyncItemSchema()

# Two timestamps within this many seconds count as the same sale on a retry.
RETRY_TIMESTAMP_TOLERANCE_SECONDS = 2


class SyncLineError(Exception):
    """A sync line was rejected; `reason` is shown to the client."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class _Costing:
    batch: StockBatch
    cost_at_sale: float
    profit: float
    allocations: list[dict] | None  # exact per-batch deduction map, for void restores
    qty_base: float | None


def restore_to_batch(batch_id: int, qty_base: float) -> None:
    """Put qty_base back on a batch (in base_unit), reopening it if it closed.

    A batch that auto-closed when a sale emptied it must reopen so the
    restored stock is sellable again — a closed batch's remaining stock is
    invisible to FIFO and would be trapped.
    """
    batch = db.session.get(StockBatch, batch_id)
    if batch is None:
        return  # batch no longer exists — nothing to restore (shouldn't happen)
    batch.quantity_remaining += qty_base
    if batch.status == BatchStatus.closed:
        batch.status = BatchStatus.open
        batch.closed_at = None


def fifo_deduct(product: Product, qty_in_base_unit: float):
    """
    Deduct qty_in_base_unit from open batches FIFO.
    Returns (cost_at_sale_per_base_unit, batch_used, allocations) or raises
    ValueError if stock insufficient. `allocations` is the exact per-batch
    breakdown of the deduction — the map a void needs to put each unit back
    on the batch that actually supplied it.
    """
    open_batches = (
        StockBatch.query
        .filter_by(product_id=product.id, status=BatchStatus.open)
        .order_by(StockBatch.date_received.asc())
        .with_for_update()  # row-lock on Postgres so concurrent syncs can't oversell
        .all()
    )
    total_available = sum(b.quantity_remaining for b in open_batches)
    if total_available < qty_in_base_unit:
        raise ValueError(
            f"Insufficient stock: need {qty_in_base_unit:.4f} {product.base_unit.value}, "
            f"only {total_available:.4f} available."
        )

    remaining_to_deduct = qty_in_base_unit
    first_batch = None  # oldest batch that supplies cost_at_sale
    weighted_cost_num = 0.0
    allocations: list[dict] = []  # (batch_id, qty) in base_unit

    for batch in open_batches:
        if remaining_to_deduct <= 0:
            break
        deduct = min(batch.quantity_remaining, remaining_to_deduct)
        if first_batch is None:
            first_batch = batch
        allocations.append({"batch_id": batch.id, "qty": deduct})
        weighted_cost_num += deduct * batch.cost_per_base_unit
        batch.quantity_remaining -= deduct
        remaining_to_deduct -= deduct
        batch.close_if_empty()

    # Weighted average cost across all batches consumed
    cost_per_base_unit = weighted_cost_num / qty_in_base_unit if qty_in_base_unit else 0
    return cost_per_base_unit, first_batch, allocations


def _as_utc(dt: datetime) -> datetime:
    """Normalize a datetime to timezone-aware UTC.

    SQLite round-trips DateTime(timezone=True) as naive UTC, while marshmallow
    parses client timestamps as aware datetimes — both sides must be aware
    before subtraction, or Python raises TypeError (aware minus naive).
    """
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _same_sale_payload(existing: Sale, data: dict) -> bool:
    """True when the incoming line is a genuine retry of `existing`.

    A retry re-sends the exact same business fields. If the uuid matches but
    the content differs, it's a cross-device id collision — which the client
    would otherwise treat as a successful 'duplicate' and permanently drop
    the sale. Compare every money-relevant field plus a timestamp tolerance.
    """
    return (
        existing.product_id == data["product_id"]
        and existing.attendant_id == data["attendant_id"]
        and abs(existing.quantity_sold - data["quantity_sold"]) < 1e-9
        and existing.unit_sold_in == data["unit_sold_in"]
        and abs(existing.price_charged - data["price_charged"]) < 1e-9
        and abs((_as_utc(existing.created_at) - _as_utc(data["created_at"])).total_seconds())
        < RETRY_TIMESTAMP_TOLERANCE_SECONDS
    )


def _error(client_uuid: str, reason: str) -> dict:
    return {"client_uuid": client_uuid, "status": "error", "reason": reason}


def _existing_sale_result(existing: Sale, data: dict, client_uuid: str) -> dict:
    if _same_sale_payload(existing, data):
        # Genuine retry — safe to ack as a duplicate.
        return {"client_uuid": client_uuid, "status": "duplicate", "sale_id": existing.id}
    # Same uuid, different content: a cross-device id collision. Surface it
    # loudly instead of silently dropping the sale (the client treats
    # 'duplicate' as success).
    return _error(
        client_uuid,
        "client_uuid already used by a different sale — offline sync conflict, ask the owner to check.",
    )


def _load_product_and_attendant(data: dict) -> tuple[Product, Attendant]:
    product = db.session.get(Product, data["product_id"])
    if not product:
        raise SyncLineError("Product not found.")
    attendant = db.session.get(Attendant, data["attendant_id"])
    if not attendant or not attendant.active:
        raise SyncLineError("Attendant not found or inactive.")
    return product, attendant


def _check_counted_amount(product: Product, data: dict) -> None:
    """A tracked counted option ("3 tomatoes" → amount 3) must consume exactly
    what it claims when sold in the base unit. The amount is what routes the
    line into FIFO; if it disagrees with quantity_sold the deduction would
    silently drift from the button the attendant pressed. Weighed portions and
    piece→kg conversions are unaffected (amount is only sent by counted
    options sold in their base unit).
    """
    amt = data.get("amount_in_base_unit")
    if amt is None or data["unit_sold_in"] != product.base_unit.value:
        return
    if abs(amt - data["quantity_sold"]) > 1e-6:
        raise SyncLineError(
            "amount_in_base_unit does not match quantity_sold for this selling option — "
            "update the app or check the sale."
        )


def _cost_untracked(product: Product) -> _Costing:
    """Legacy counted (untracked estimate): the sale is logged at the button's
    fixed price (quantity_sold=1, price_charged = that price) against the
    OLDEST OPEN batch, so the batch's P&L (revenue_so_far - total_cost) stays
    correct. Nothing is deducted from quantity_remaining — the option has no
    amount, so there is no piece-level stock truth to deduct.
    """
    open_batch = (
        StockBatch.query
        .filter_by(product_id=product.id, status=BatchStatus.open)
        .order_by(StockBatch.date_received.asc())
        .first()
    )
    if open_batch is None:
        raise SyncLineError("No open batch for this product — record a new delivery first.")
    # Counted profit lives at the batch level.
    return _Costing(batch=open_batch, cost_at_sale=0.0, profit=0.0, allocations=None, qty_base=None)


def _cost_per_sold_unit(product: Product, unit_sold_in: str, cost_per_base: float) -> float:
    """FIFO cost is per base unit; price_charged is per unit_sold_in. Same unit
    compares directly; a piece sold from a kg product needs the piece weight."""
    if unit_sold_in != product.base_unit.value and unit_sold_in == "piece" and product.base_unit.value == "kg":
        return cost_per_base * (product.avg_piece_weight or 1)
    return cost_per_base


def _cost_tracked(product: Product, data: dict) -> _Costing:
    """Weighed products, and counted products whose selling option carries an
    exact base-unit amount: convert to base unit, FIFO-deduct, snapshot cost."""
    try:
        qty_base = to_base_unit(
            data["quantity_sold"],
            data["unit_sold_in"],
            product.base_unit.value,
            product.avg_piece_weight,
        )
        cost_per_base, batch, allocations = fifo_deduct(product, qty_base)
    except ValueError as e:
        raise SyncLineError(str(e)) from e

    cost_at_sale = _cost_per_sold_unit(product, data["unit_sold_in"], cost_per_base)
    # Total profit for the line: (price per unit - cost per unit) * qty sold.
    profit = (data["price_charged"] - cost_at_sale) * data["quantity_sold"]
    return _Costing(batch=batch, cost_at_sale=cost_at_sale, profit=profit, allocations=allocations, qty_base=qty_base)


def _cost_line(product: Product, data: dict) -> _Costing:
    # A counted product uses exact FIFO accounting only when its selling option
    # carries a base-unit amount. Counted lines without one are legacy
    # untracked estimate sales and keep the old batch-P&L behavior.
    counted = product.pricing_mode == PricingMode.counted
    tracked = not counted or data.get("amount_in_base_unit") is not None
    return _cost_tracked(product, data) if tracked else _cost_untracked(product)


def _build_sale(data: dict, product: Product, attendant: Attendant, costing: _Costing, now: datetime) -> Sale:
    return Sale(
        client_uuid=data["client_uuid"],
        product_id=product.id,
        batch_id=costing.batch.id,
        attendant_id=attendant.id,
        quantity_sold=data["quantity_sold"],
        unit_sold_in=data["unit_sold_in"],
        price_charged=data["price_charged"],
        cost_at_sale=costing.cost_at_sale,
        profit=costing.profit,
        batch_allocations=costing.allocations or None,
        # Transaction grouping + historical snapshots, captured at sync time
        sale_uuid=data.get("sale_uuid"),
        product_name_snapshot=product.name,
        button_label_snapshot=data.get("button_label"),
        button_count_snapshot=data.get("count"),
        quantity_base=costing.qty_base,
        sync_status=SyncStatus.synced,
        created_at=data["created_at"],
        synced_at=now,
    )


def _persist_line(sale: Sale, product: Product, client_uuid: str) -> dict:
    """Commit per line: a failure here rolls back only THIS line's pending
    changes (sale row + batch deduction), so lines already reported "synced"
    stay durable."""
    db.session.add(sale)
    try:
        db.session.flush()  # get sale.id
        sale_id = sale.id
        product.refresh_cost_cache()  # after batch changes
        db.session.commit()
    except Exception:
        db.session.rollback()
        logger.exception("sync: could not save line client_uuid=%s", client_uuid)
        return _error(
            client_uuid,
            "Could not save this sale on the server — try again, or ask the owner to check.",
        )
    return {"client_uuid": client_uuid, "status": "synced", "sale_id": sale_id}


def sync_one_line(raw, *, forced_attendant_id: int | None, now: datetime) -> dict:
    """Process one offline sale line and return its per-item result dict.

    `forced_attendant_id` is the JWT identity for non-owner sessions: an
    attendant's session can only record sales under themselves, so any payload
    attendant_id is ignored. Only the owner (who PIN-verifies the attendant at
    the till) may attribute a sale to a different attendant. The JWT identity
    is the authority, never the payload.
    """
    if not isinstance(raw, dict):
        return _error("<unknown>", "Each sale line must be an object.")
    client_uuid = raw.get("client_uuid", "<unknown>")

    try:
        data = sync_item_schema.load(raw)
    except ValidationError as e:
        return _error(client_uuid, str(e.messages))

    if forced_attendant_id is not None:
        data["attendant_id"] = forced_attendant_id
    client_uuid = data["client_uuid"]

    existing = Sale.query.filter_by(client_uuid=client_uuid).first()
    if existing:
        return _existing_sale_result(existing, data, client_uuid)

    try:
        product, attendant = _load_product_and_attendant(data)
        _check_counted_amount(product, data)
        costing = _cost_line(product, data)
    except SyncLineError as e:
        return _error(client_uuid, e.reason)

    sale = _build_sale(data, product, attendant, costing, now)
    return _persist_line(sale, product, client_uuid)
