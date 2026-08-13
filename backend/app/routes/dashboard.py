"""Dashboard routes."""
from datetime import timedelta

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required
from flask import current_app

from app.extensions import db
from app.models.product import Product, PricingMode
from app.models.sale import Sale
from app.utils.timezone import business_day_bounds, db_ready_utc, shop_date_of, shop_now, today_shop_date

dashboard_bp = Blueprint("dashboard", __name__)


def _is_legacy_counted(sale) -> bool:
    """A counted sale that never deducted stock (legacy estimate button).

    Identified by its missing base-unit quantity: tracked counted sales (the
    selling button carried an exact amount) consume stock through FIFO and
    snapshot real cost/profit like weighed sales; legacy counted sales
    (amount NULL) recorded revenue only, with no sale-level cost to compare
    against — their P&L lives per batch.
    """
    return (
        sale.product is not None
        and sale.product.pricing_mode == PricingMode.counted
        and sale.quantity_base is None
    )


@dashboard_bp.get("/summary")
@jwt_required()
def summary():
    """
    GET /api/dashboard/summary
    Returns:
      - today's revenue / cost / profit
      - per-product margin breakdown
      - low-margin sales flagged below configurable threshold
      - low-stock products list
    """
    today_str = today_shop_date()
    threshold = current_app.config.get("LOW_MARGIN_THRESHOLD", 0.10)

    # ---------- Today's sales (Kenya business day) ----------
    start_utc, end_utc = business_day_bounds(today_str)
    today_sales = Sale.query.filter(
        Sale.created_at >= db_ready_utc(start_utc),
        Sale.created_at < db_ready_utc(end_utc),
    ).all()

    total_revenue = sum(s.revenue for s in today_sales)
    total_cost = sum(s.cost_at_sale * s.quantity_sold for s in today_sales)
    total_profit = sum(s.profit for s in today_sales)
    # Only legacy counted sales (never deducted stock, no sale-level cost)
    # carry revenue with no matching profit, so their revenue is blended out
    # of the headline margin to keep it consistent with the profit figure.
    # Tracked counted sales — the selling button carries an exact amount and
    # FIFO snapshots real cost/profit — count into the margin like weighed
    # sales.
    margin_revenue = sum(
        s.revenue
        for s in today_sales
        if not _is_legacy_counted(s)
    )

    # ---------- Per-product margins (today) ----------
    from collections import defaultdict
    product_revenue: dict = defaultdict(float)
    product_cost: dict = defaultdict(float)
    product_names: dict = {}

    for sale in today_sales:
        pid = sale.product_id
        product_revenue[pid] += sale.revenue
        product_cost[pid] += sale.cost_at_sale * sale.quantity_sold
        product_names[pid] = sale.product.name if sale.product else str(pid)

    per_product = []
    for pid in product_revenue:
        rev = product_revenue[pid]
        cost = product_cost[pid]
        profit = rev - cost
        margin = profit / rev if rev else 0
        pid_sales = [s for s in today_sales if s.product_id == pid]
        counted = any(s.product and s.product.pricing_mode == PricingMode.counted for s in pid_sales)
        # A counted product's per-sale margin is only meaningful once it has
        # tracked (amount-carrying) sales — those consume stock via FIFO and
        # snapshot real cost/profit, exactly like weighed products. Products
        # that only ever sold through legacy estimate buttons (quantity_base
        # NULL, no deduction, no cost) keep margin_pct None so the UI shows
        # "Sold by piece" instead of a misleading 0% from zero-cost revenue.
        tracked_counted = counted and any(s.quantity_base is not None for s in pid_sales)
        margin_pct = None if (counted and not tracked_counted) else round(margin, 4)
        per_product.append({
            "product_id": pid,
            "product_name": product_names[pid],
            "revenue": round(rev, 2),
            "cost": round(cost, 2),
            "profit": round(profit, 2),
            "margin_pct": margin_pct,
            "low_margin": False if margin_pct is None else margin_pct < threshold,
        })

    # Counted products have margin_pct=None — sort them after the weighed
    # products (which sort by margin, worst first).
    per_product.sort(key=lambda x: (x["margin_pct"] is None, x["margin_pct"] or 0))

    # ---------- Low-margin sales (today) ----------
    # Only legacy counted sales are never flagged — they carry no sale-level
    # profit (their P&L lives per batch). Tracked counted sales have real
    # margin math and are flagged like weighed sales.
    low_margin_sales = [
        {
            "sale_id": s.id,
            "client_uuid": s.client_uuid,
            "product_id": s.product_id,
            "product_name": s.product.name if s.product else None,
            "attendant_name": s.attendant.name if s.attendant else None,
            "revenue": round(s.revenue, 2),
            "profit": round(s.profit, 2),
            "margin_pct": round(s.margin_pct, 4),
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in today_sales
        if not _is_legacy_counted(s) and s.margin_pct < threshold
    ]

    # ---------- Low-stock products ----------
    all_products = Product.query.all()
    low_stock = [
        {
            "product_id": p.id,
            "product_name": p.name,
            "base_unit": p.base_unit.value,
            "total_stock": round(p.total_stock, 4),
            "reorder_threshold": p.reorder_threshold,
        }
        for p in all_products
        if p.is_low_stock
    ]

    return jsonify({
        "date": today_str,
        "low_margin_threshold": threshold,
        "today": {
            "sale_count": len(today_sales),
            "revenue": round(total_revenue, 2),
            "cost": round(total_cost, 2),
            "profit": round(total_profit, 2),
            "margin_pct": round(total_profit / margin_revenue, 4) if margin_revenue else 0,
        },
        "per_product": per_product,
        "low_margin_sales": low_margin_sales,
        "low_stock_products": low_stock,
    }), 200


@dashboard_bp.get("/series")
@jwt_required()
def series():
    """
    GET /api/dashboard/series?days=N — server-aggregated daily revenue/profit.

    Business days are Africa/Nairobi. The result is zero-filled so the chart
    never has holes, and voided sales are excluded. Keeps bulk sale history
    off the wire: the browser only ever receives N aggregate points.
    """
    days = min(90, max(1, request.args.get("days", 14, type=int)))
    today = shop_now().date()
    start_day = today - timedelta(days=days - 1)
    start_utc, _ = business_day_bounds(start_day.strftime("%Y-%m-%d"))

    sales = Sale.query.filter(
        Sale.created_at >= db_ready_utc(start_utc),
        Sale.voided_at.is_(None),
    ).all()

    buckets: dict = {}
    for s in sales:
        day = shop_date_of(s.created_at)
        b = buckets.setdefault(day, {"revenue": 0.0, "profit": 0.0, "sale_count": 0})
        b["revenue"] += s.revenue
        b["profit"] += s.profit
        b["sale_count"] += 1

    out = []
    for i in range(days):
        key = (start_day + timedelta(days=i)).strftime("%Y-%m-%d")
        b = buckets.get(key) or {"revenue": 0.0, "profit": 0.0, "sale_count": 0}
        out.append({
            "date": key,
            "revenue": round(b["revenue"], 2),
            "profit": round(b["profit"], 2),
            "sale_count": b["sale_count"],
        })

    return jsonify({"days": days, "series": out}), 200
