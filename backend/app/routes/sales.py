"""
Sales routes — including the critical offline-sync endpoint.

POST /api/sales/sync  — accepts a batch array of offline sales.
For each item:
  1. Dedup by client_uuid (idempotent)
  2. Convert quantity to base_unit
  3. Out-of-stock guard
  4. FIFO deduction across open batches
  5. Snapshot cost_at_sale + compute profit
  6. Persist Sale row, update batch quantity_remaining
  7. Return per-item result so frontend retries only failures

KES PRECISION INVARIANT: price_charged, quantity_sold, cost_at_sale and
profit are stored at FULL float precision. KES rounding happens ONLY at
serialisation/display (round(x, 2)). Never round mid-chain — an odd-sized
button sale (e.g. KSh20 for 0.75 kg -> price_charged = 20/0.75 = 26.666…)
depends on the full-precision rate flowing through to revenue/profit, which
then round to the exact shillings. test_odd_sized_button_sales_keep_exact_money
pins this; it fails if price_charged ever becomes Numeric(10,2) or anything
rounds before the money math completes.
"""
import csv
from datetime import datetime, timezone
from io import StringIO

from flask import Blueprint, request, jsonify, Response
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from marshmallow import ValidationError

from app.extensions import db
from app.models.attendant import Attendant
from app.models.product import Product, PricingMode
from app.models.sale import Sale, SyncStatus
from app.models.stock_batch import StockBatch, BatchStatus
from app.schemas.sale_schema import SaleSchema, SaleSyncItemSchema
from app.utils.timezone import SHOP_TZ, business_day_bounds, db_ready_utc, today_shop_date
from app.utils.unit_conversion import to_base_unit

sales_bp = Blueprint("sales", __name__)
sale_schema = SaleSchema()
sales_schema = SaleSchema(many=True)
sync_item_schema = SaleSyncItemSchema()


def _restore_to_batch(batch_id: int, qty_base: float) -> None:
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


def _csv_safe(value) -> str:
    """Neutralize spreadsheet formula injection.

    Excel/Sheets treat cells starting with =, +, -, or @ as formulas (or
    hyperlink commands). Product and attendant names are user-controlled, so
    a name like "=SUM(A1:A9)" would execute when the owner opens the export.
    Prefixing those cells with a single quote makes them inert text.
    """
    s = str(value) if value is not None else ""
    return "'" + s if s.startswith(("=", "+", "-", "@")) else s


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
        and abs((_as_utc(existing.created_at) - _as_utc(data["created_at"])).total_seconds()) < 2
    )


def _fifo_deduct(product: Product, qty_in_base_unit: float):
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


@sales_bp.post("/sync")
@jwt_required()
def sync_sales():
    """
    POST /api/sales/sync
    Body: { "sales": [ SaleSyncItem, ... ] }
    Returns:
      { "results": [ { "client_uuid": "...", "status": "synced"|"duplicate"|"error", "sale_id"?: int, "reason"?: str } ] }
    """
    payload = request.get_json(silent=True) or {}
    raw_items = payload.get("sales", [])

    if not isinstance(raw_items, list):
        return jsonify({"error": "'sales' must be an array."}), 422

    results = []
    now = datetime.now(timezone.utc)
    claims = get_jwt()

    for raw in raw_items:
        uuid = raw.get("client_uuid", "<unknown>")

        # --- 1. Validate item schema ---
        try:
            data = sync_item_schema.load(raw)
        except ValidationError as e:
            results.append({"client_uuid": uuid, "status": "error", "reason": str(e.messages)})
            continue

        # --- 1b. Attribution trust boundary ---
        # The PIN is verified at the till before checkout, but a client can
        # still send an arbitrary attendant_id in the payload. An attendant's
        # own session can only ever record sales under themselves — any
        # payload attendant_id is ignored. Only the owner (who PIN-verifies
        # the attendant at the till) may attribute a sale to a different
        # attendant. The JWT identity is the authority, never the payload.
        if claims.get("role") != "owner":
            data["attendant_id"] = int(get_jwt_identity())

        uuid = data["client_uuid"]

        # --- 2. Idempotency check ---
        existing = Sale.query.filter_by(client_uuid=uuid).first()
        if existing:
            if _same_sale_payload(existing, data):
                # Genuine retry — safe to ack as a duplicate.
                results.append({"client_uuid": uuid, "status": "duplicate", "sale_id": existing.id})
            else:
                # Same uuid, different content: a cross-device id collision.
                # Surface it loudly instead of silently dropping the sale
                # (the client treats 'duplicate' as success).
                results.append({
                    "client_uuid": uuid,
                    "status": "error",
                    "reason": "client_uuid already used by a different sale — offline sync conflict, ask the owner to check.",
                })
            continue

        # --- 3. Validate product & attendant ---
        product = db.session.get(Product, data["product_id"])
        if not product:
            results.append({"client_uuid": uuid, "status": "error", "reason": "Product not found."})
            continue

        attendant = db.session.get(Attendant, data["attendant_id"])
        if not attendant or not attendant.active:
            results.append({"client_uuid": uuid, "status": "error", "reason": "Attendant not found or inactive."})
            continue

        # A tracked counted option ("3 tomatoes" → amount 3) must consume
        # exactly what it claims when sold in the base unit. The amount is
        # what routes the line into FIFO; if it disagrees with quantity_sold
        # the deduction would silently drift from the button the attendant
        # pressed. Weighed portions and piece→kg conversions are unaffected
        # (amount is only sent by counted options sold in their base unit).
        amt = data.get("amount_in_base_unit")
        if amt is not None and data["unit_sold_in"] == product.base_unit.value:
            if abs(amt - data["quantity_sold"]) > 1e-6:
                results.append({
                    "client_uuid": uuid,
                    "status": "error",
                    "reason": "amount_in_base_unit does not match quantity_sold for this selling option — update the app or check the sale.",
                })
                continue

        # --- 4/5/6. Costing depends on the product's pricing mode ---
        # A counted product uses exact FIFO accounting only when its selling
        # option carries a base-unit amount ("3 tomatoes" → amount_in_base_unit
        # = 3, quantity_sold = 3 pieces). Counted lines without an amount are
        # legacy untracked estimate sales and keep the old batch-P&L behavior
        # (no deduction; cost/profit live at the batch level).
        counted = product.pricing_mode == PricingMode.counted
        tracked = not counted or data.get("amount_in_base_unit") is not None
        allocations = None  # exact per-batch deduction map, for exact void restores
        qty_base = None

        if not tracked:
            # Legacy counted (untracked estimate): the sale is logged at the
            # button's fixed price (quantity_sold=1, price_charged = that price)
            # against the OLDEST OPEN batch, so the batch's P&L
            # (revenue_so_far - total_cost) stays correct. Nothing is deducted
            # from quantity_remaining — the option has no amount, so there is
            # no piece-level stock truth to deduct.
            open_batch = (
                StockBatch.query
                .filter_by(product_id=product.id, status=BatchStatus.open)
                .order_by(StockBatch.date_received.asc())
                .first()
            )
            if open_batch is None:
                results.append({
                    "client_uuid": uuid,
                    "status": "error",
                    "reason": "No open batch for this product — record a new delivery first.",
                })
                continue
            batch = open_batch
            cost_at_sale = 0.0
            profit = 0.0  # counted profit lives at the batch level
        else:
            # Tracked path — weighed products, and counted products whose
            # selling option carries an exact base-unit amount. Identical FIFO
            # accounting for both.
            # --- Convert quantity to base_unit ---
            try:
                qty_base = to_base_unit(
                    data["quantity_sold"],
                    data["unit_sold_in"],
                    product.base_unit.value,
                    product.avg_piece_weight,
                )
            except ValueError as e:
                results.append({"client_uuid": uuid, "status": "error", "reason": str(e)})
                continue

            # --- FIFO deduction + cost snapshot ---
            try:
                cost_per_base, batch, allocations = _fifo_deduct(product, qty_base)
            except ValueError as e:
                results.append({"client_uuid": uuid, "status": "error", "reason": str(e)})
                continue

            # --- Compute profit (snapshot) ---
            # profit = (price_charged_per_unit - cost_per_unit_in_sold_unit) * qty_sold
            # We store total profit for the line item.
            # price_charged is already per unit_sold_in; cost_per_base is per base_unit.
            # If unit_sold_in == base_unit, direct comparison. If piece→kg, normalise.
            if data["unit_sold_in"] == product.base_unit.value:
                cost_at_sale = cost_per_base  # per unit_sold_in
            else:
                # piece → kg: cost_at_sale per piece = cost_per_kg * avg_piece_weight
                if data["unit_sold_in"] == "piece" and product.base_unit.value == "kg":
                    cost_at_sale = cost_per_base * (product.avg_piece_weight or 1)
                else:
                    cost_at_sale = cost_per_base

            profit = (data["price_charged"] - cost_at_sale) * data["quantity_sold"]

        # --- 7. Persist ---
        sale = Sale(
            client_uuid=uuid,
            product_id=product.id,
            batch_id=batch.id,
            attendant_id=attendant.id,
            quantity_sold=data["quantity_sold"],
            unit_sold_in=data["unit_sold_in"],
            price_charged=data["price_charged"],
            cost_at_sale=cost_at_sale,
            profit=profit,
            batch_allocations=allocations or None,
            # Transaction grouping + historical snapshots, captured at sync time
            sale_uuid=data.get("sale_uuid"),
            product_name_snapshot=product.name,
            button_label_snapshot=data.get("button_label"),
            button_count_snapshot=data.get("count"),
            quantity_base=qty_base,
            sync_status=SyncStatus.synced,
            created_at=data["created_at"],
            synced_at=now,
        )
        db.session.add(sale)

        try:
            db.session.flush()  # get sale.id before committing the batch
        except Exception as e:
            db.session.rollback()
            results.append({"client_uuid": uuid, "status": "error", "reason": str(e)})
            continue

        # Refresh product cost cache after batch changes
        product.refresh_cost_cache()

        results.append({"client_uuid": uuid, "status": "synced", "sale_id": sale.id})

    # Commit everything that didn't individually fail
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": f"Database commit failed: {e}"}), 500

    return jsonify({"results": results}), 200


@sales_bp.post("/<int:sale_id>/void")
@jwt_required()
def void_sale(sale_id: int):
    """
    POST /api/sales/<id>/void — reverse a synced sale and restore its stock.
    Owners can void any sale, any time. Attendants can only void their own
    sales within 15 minutes of the sale; older ones need the owner.
    """
    sale = db.session.get(Sale, sale_id)
    if not sale:
        return jsonify({"error": "Sale not found."}), 404
    if sale.voided_at is not None:
        return jsonify({"error": "Sale is already voided."}), 409

    claims = get_jwt()
    caller_id = int(get_jwt_identity())

    if claims.get("role") != "owner":
        if sale.attendant_id != caller_id:
            return jsonify({"error": "You can only void your own sales — ask the owner for help."}), 403
        created = sale.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - created).total_seconds() > 15 * 60:
            return jsonify({"error": "Only the owner can void a sale older than 15 minutes — ask them to do it."}), 403

    # Restore the sold quantity to its batch(es); reopen any that had closed.
    # Legacy counted sales (untracked estimate buttons) never deducted stock,
    # so there is nothing to restore — their revenue just leaves the batch's
    # P&L (revenue_so_far - total_cost). Tracked counted sales deduct like any
    # weighed sale and restore the same way.
    batch = sale.batch
    if batch:
        legacy_counted = (
            sale.product is not None
            and sale.product.pricing_mode == PricingMode.counted
            and sale.quantity_base is None
            and not sale.batch_allocations
        )
        if not legacy_counted:
            if sale.batch_allocations:
                # Exact FIFO restore: each unit goes back to the batch that
                # supplied it — a single sale can span several batches.
                for alloc in sale.batch_allocations:
                    _restore_to_batch(alloc["batch_id"], alloc["qty"])
            else:
                # Legacy sale (recorded before batch_allocations existed):
                # restore everything to the recorded batch — exactly as this
                # always did. Prefer the stored base-unit quantity so the
                # restore is exact even if the product's conversion config has
                # changed since; fall back to converting with today's config.
                if sale.quantity_base is not None:
                    qty_base = sale.quantity_base
                elif sale.product:
                    qty_base = to_base_unit(
                        sale.quantity_sold,
                        sale.unit_sold_in,
                        sale.product.base_unit.value,
                        sale.product.avg_piece_weight,
                    )
                else:
                    qty_base = sale.quantity_sold
                _restore_to_batch(batch.id, qty_base)

    sale.voided_at = datetime.now(timezone.utc)
    sale.voided_by = caller_id

    if sale.product:
        sale.product.refresh_cost_cache()

    db.session.commit()
    return jsonify(sale_schema.dump(sale)), 200


@sales_bp.get("")
@jwt_required()
def list_sales():
    """
    GET /api/sales — list, filterable by ?date=YYYY-MM-DD&attendant_id=&product_id=
    Attendants are always scoped to their own sales; owners may query anyone.
    Voided sales are hidden unless ?include_voided=true.
    """
    # Only the owner may opt into seeing voided sales.
    claims = get_jwt()
    include_voided = (
        claims.get("role") == "owner"
        and request.args.get("include_voided", "false").lower() in ("1", "true", "yes")
    )
    q = Sale.query
    if not include_voided:
        q = q.filter(Sale.voided_at.is_(None))

    # Non-owners can only ever see their own sales — any attendant_id param is ignored.
    if claims.get("role") != "owner":
        q = q.filter(Sale.attendant_id == int(get_jwt_identity()))
    else:
        attendant_id = request.args.get("attendant_id", type=int)
        if attendant_id:
            q = q.filter(Sale.attendant_id == attendant_id)

    product_id = request.args.get("product_id", type=int)
    if product_id:
        q = q.filter(Sale.product_id == product_id)

    date_str = request.args.get("date")
    if date_str:
        # Business-day filter in Kenya time — a local day spans two UTC dates.
        try:
            start_utc, end_utc = business_day_bounds(date_str)
        except ValueError:
            return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 422
        q = q.filter(
            Sale.created_at >= db_ready_utc(start_utc),
            Sale.created_at < db_ready_utc(end_utc),
        )

    sales = q.order_by(Sale.created_at.desc()).limit(500).all()
    return jsonify(sales_schema.dump(sales)), 200


@sales_bp.get("/page")
@jwt_required()
def page_sales():
    """
    GET /api/sales/page — paginated sales list for the Sales screen.
    Params: from=YYYY-MM-DD&to=YYYY-MM-DD&attendant_id=&product_id=
            &page=&per_page= (days are Kenya business days)
    Returns { items, total, page, per_page, has_more }.
    Non-owners are always scoped to their own sales; voided sales are hidden
    unless include_voided=true (owner only).
    """
    claims = get_jwt()
    include_voided = (
        claims.get("role") == "owner"
        and request.args.get("include_voided", "false").lower() in ("1", "true", "yes")
    )
    q = Sale.query
    if not include_voided:
        q = q.filter(Sale.voided_at.is_(None))

    if claims.get("role") != "owner":
        q = q.filter(Sale.attendant_id == int(get_jwt_identity()))
    else:
        attendant_id = request.args.get("attendant_id", type=int)
        if attendant_id:
            q = q.filter(Sale.attendant_id == attendant_id)

    product_id = request.args.get("product_id", type=int)
    if product_id:
        q = q.filter(Sale.product_id == product_id)

    date_from = request.args.get("from")
    date_to = request.args.get("to")
    try:
        if date_from:
            start_utc, _ = business_day_bounds(date_from)
            q = q.filter(Sale.created_at >= db_ready_utc(start_utc))
        if date_to:
            _, end_utc = business_day_bounds(date_to)
            q = q.filter(Sale.created_at < db_ready_utc(end_utc))
    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 422

    page = max(1, request.args.get("page", 1, type=int))
    per_page = min(200, max(1, request.args.get("per_page", 50, type=int)))
    total = q.count()
    items = (
        q.order_by(Sale.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return jsonify({
        "items": sales_schema.dump(items),
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": page * per_page < total,
    }), 200


@sales_bp.get("/export")
@jwt_required()
def export_sales_csv():
    """
    GET /api/sales/export — CSV download of the Sales screen's current view.

    Same date/attendant/product filters and role scoping as GET /api/sales/page:
    non-owners only ever export their own sales. Voided sales are included and
    flagged in the Status column so the file is a complete record.

    Columns: Date/time (shop-local), Transaction, Product, Selling button,
    Count, Quantity/base amount, Revenue, Cost, Profit, Attendant, Status.
    """
    claims = get_jwt()
    q = Sale.query

    if claims.get("role") != "owner":
        q = q.filter(Sale.attendant_id == int(get_jwt_identity()))
    else:
        attendant_id = request.args.get("attendant_id", type=int)
        if attendant_id:
            q = q.filter(Sale.attendant_id == attendant_id)

    product_id = request.args.get("product_id", type=int)
    if product_id:
        q = q.filter(Sale.product_id == product_id)

    date_from = request.args.get("from")
    date_to = request.args.get("to")
    try:
        if date_from:
            start_utc, _ = business_day_bounds(date_from)
            q = q.filter(Sale.created_at >= db_ready_utc(start_utc))
        if date_to:
            _, end_utc = business_day_bounds(date_to)
            q = q.filter(Sale.created_at < db_ready_utc(end_utc))
    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 422

    # Same 500-line cap as GET /api/sales — a generous, bounded export.
    sales = q.order_by(Sale.created_at.desc()).limit(500).all()

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "Date/time", "Transaction", "Product", "Selling button", "Count",
        "Quantity/base amount", "Revenue", "Cost", "Profit", "Attendant", "Status",
    ])

    for s in sales:
        created = s.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        local = created.astimezone(SHOP_TZ)

        # Group key — mirror the Sales screen: sale_uuid when present, else the
        # client_uuid prefix ("<cartId>-<productId>-<lineIndex>").
        if s.sale_uuid:
            txn = s.sale_uuid
        else:
            parts = (s.client_uuid or "").split("-")
            txn = "-".join(parts[:-2]) if len(parts) > 2 else (s.client_uuid or "")

        qty = s.quantity_base if s.quantity_base is not None else s.quantity_sold
        product_name = s.product_name_snapshot or (s.product.name if s.product else "")
        attendant_name = s.attendant.name if s.attendant else ""

        writer.writerow([
            local.strftime("%Y-%m-%d %H:%M"),
            _csv_safe(txn),
            _csv_safe(product_name),
            _csv_safe(s.button_label_snapshot),
            s.button_count_snapshot if s.button_count_snapshot is not None else "",
            f"{qty:g} {s.unit_sold_in}",
            round(s.revenue, 2),
            round(s.cost_at_sale * s.quantity_sold, 2),
            round(s.profit, 2),
            _csv_safe(attendant_name),
            "voided" if s.voided_at else "synced",
        ])

    # BOM so Excel opens the UTF-8 file with the right characters.
    csv_data = "\ufeff" + buf.getvalue()
    resp = Response(csv_data, mimetype="text/csv; charset=utf-8")
    resp.headers["Content-Disposition"] = "attachment; filename=sokomtaani-sales.csv"
    return resp


@sales_bp.get("/daily-summary")
@jwt_required()
def daily_summary():
    """
    GET /api/sales/daily-summary?date=YYYY-MM-DD   (one Kenya business day)
    or ?from=YYYY-MM-DD&to=YYYY-MM-DD             (range of Kenya business days)
    Returns total revenue, cost, profit for the day/range.
    """
    day_str = request.args.get("date") or today_shop_date()
    date_from = request.args.get("from") or day_str
    date_to = request.args.get("to") or day_str
    try:
        start_utc, _ = business_day_bounds(date_from)
        _, end_utc = business_day_bounds(date_to)
    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 422

    # Only the owner may opt into seeing voided sales.
    claims = get_jwt()
    include_voided = (
        claims.get("role") == "owner"
        and request.args.get("include_voided", "false").lower() in ("1", "true", "yes")
    )
    q = Sale.query
    if not include_voided:
        q = q.filter(Sale.voided_at.is_(None))

    sales = q.filter(
        Sale.created_at >= db_ready_utc(start_utc),
        Sale.created_at < db_ready_utc(end_utc),
    ).all()

    total_revenue = sum(s.revenue for s in sales)
    total_cost = sum(s.cost_at_sale * s.quantity_sold for s in sales)
    total_profit = sum(s.profit for s in sales)
    sale_count = len(sales)

    return jsonify({
        "date": date_from,
        "date_to": date_to,
        "sale_count": sale_count,
        "total_revenue": round(total_revenue, 2),
        "total_cost": round(total_cost, 2),
        "total_profit": round(total_profit, 2),
        "margin_pct": round(total_profit / total_revenue, 4) if total_revenue else 0,
    }), 200
