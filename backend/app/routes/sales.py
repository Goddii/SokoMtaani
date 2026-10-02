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
import logging
from datetime import datetime, timezone
from io import StringIO

from flask import Blueprint, request, jsonify, Response
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt

from app.extensions import db
from app.models.product import PricingMode
from app.models.sale import Sale
from app.schemas.sale_schema import SaleSchema
from app.services.sale_sync import restore_to_batch, sync_one_line
from app.utils.timezone import SHOP_TZ, business_day_bounds, db_ready_utc, today_shop_date
from app.utils.unit_conversion import to_base_unit

logger = logging.getLogger(__name__)

# Upper bound on lines per /sync request — a till queue is a handful of carts.
MAX_SYNC_ITEMS = 500

sales_bp = Blueprint("sales", __name__)
sale_schema = SaleSchema()
sales_schema = SaleSchema(many=True)


def _csv_safe(value) -> str:
    """Neutralize spreadsheet formula injection.

    Excel/Sheets treat cells starting with =, +, -, or @ as formulas (or
    hyperlink commands). Product and attendant names are user-controlled, so
    a name like "=SUM(A1:A9)" would execute when the owner opens the export.
    Prefixing those cells with a single quote makes them inert text.
    """
    s = str(value) if value is not None else ""
    return "'" + s if s.startswith(("=", "+", "-", "@")) else s


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
    if len(raw_items) > MAX_SYNC_ITEMS:
        return jsonify({"error": f"Too many lines — send at most {MAX_SYNC_ITEMS} per request."}), 422

    now = datetime.now(timezone.utc)
    # Non-owner sessions may only record sales under their own identity.
    is_owner = get_jwt().get("role") == "owner"
    forced_attendant_id = None if is_owner else int(get_jwt_identity())

    results = [
        sync_one_line(raw, forced_attendant_id=forced_attendant_id, now=now)
        for raw in raw_items
    ]
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
                    restore_to_batch(alloc["batch_id"], alloc["qty"])
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
                restore_to_batch(batch.id, qty_base)

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

    # Non-owners only ever see their own takings — the shop-wide total is owner data.
    if claims.get("role") != "owner":
        q = q.filter(Sale.attendant_id == int(get_jwt_identity()))

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
