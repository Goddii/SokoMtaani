"""
Regression tests — the POS COUNT control end to end.

PRICE BUTTON = what is being sold · COUNT = how many times it is sold.

A counted sale "1 tomato @ KSh5" x3 must be recorded as quantity_base = 3
(base-unit pieces consumed), revenue = KSh 15 (price x count, NOT 3 x the
"3 tomatoes" button), FIFO cost = 3 x KSh 2, profit = KSh 9 — with the count
snapshotted separately from the button's amount so history can reconstruct
"3 × 1 tomato" forever.

Covers, against the real API:
  - count on a 1-piece button (TEST A in the brief)
  - count on a 3-piece button (count x amount = 6 pieces, KSh 20)
  - count never confuses the button's amount
  - rice "1/4 kg" x2 = 0.5 kg @ KSh 80 (count applies to weighed buttons too)
  - legacy counted buttons (amount NULL) with a count: no deduction, batch P&L
  - tracked counted margin now appears on the dashboard (legacy stays "sold
    by piece")
  - attendant sessions cannot attribute sales to another attendant
  - the full Part 24 acceptance scenario (create via API, sell, void, sales
    page, dashboard)
  - offline-style payloads: exactly what the queue sends after reload, with a
    retry that must not double-deduct

Run from anywhere:
    python3 backend/tests/test_pos_count.py
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from config import config as _cfg, DevelopmentConfig  # noqa: E402
from app import create_app  # noqa: E402
from app.extensions import db, hash_pin  # noqa: E402
from app.models.attendant import Attendant, ShopRole  # noqa: E402
from app.models.product import Product, BaseUnit, Category, PricingMode  # noqa: E402
from app.models.price_button import PriceButton  # noqa: E402
from app.models.stock_batch import StockBatch, BatchStatus  # noqa: E402
from app.models.sale import Sale  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402


class _Checks:
    """Tiny assert-collector so a failing check reports a clean summary."""

    def __init__(self):
        self.failures: list[str] = []

    def check(self, cond: bool, label: str) -> None:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
        if not cond:
            self.failures.append(label)

    def done(self) -> None:
        if self.failures:
            raise SystemExit(f"FAILED: {len(self.failures)} check(s): {', '.join(self.failures)}")
        print("  ALL CHECKS PASSED")


def _make_test_app():
    tmpdir = tempfile.mkdtemp(prefix="soko-test-")
    db_path = os.path.join(tmpdir, "test.db")

    class _TestConfig(DevelopmentConfig):
        TESTING = True
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{db_path}"

    key = f"_soko_test_{os.urandom(4).hex()}"
    _cfg[key] = _TestConfig
    app = create_app(key)
    return app, tmpdir


def _mk_token(attendant_id: int, role: str = "owner") -> str:
    return create_access_token(identity=str(attendant_id), additional_claims={"role": role})


def _seed_attendant(role: ShopRole = ShopRole.owner):
    attendant = Attendant(name="Test Owner" if role == ShopRole.owner else "Test Attendant",
                          pin_hash=hash_pin("1240"), shop_role=role, active=True)
    db.session.add(attendant)
    db.session.flush()
    return attendant


def _seed_tomatoes(batch_pcs=100.0, cost_per_pc=2.0):
    """Counted product, base unit piece, tracked buttons 1/3/6, one batch."""
    attendant = _seed_attendant()
    product = Product(
        name="Tomatoes", category=Category.produce, base_unit=BaseUnit.piece,
        pricing_mode=PricingMode.counted, sell_price=0.0, reorder_threshold=10.0,
    )
    db.session.add(product)
    db.session.flush()
    product.price_buttons = [
        PriceButton(label="1 @ KSh5", kg_amount=1, price=5, sort_order=0),
        PriceButton(label="3 @ KSh10", kg_amount=3, price=10, sort_order=1),
        PriceButton(label="6 @ KSh20", kg_amount=6, price=20, sort_order=2),
    ]
    batch = StockBatch(
        product_id=product.id, bulk_quantity=batch_pcs, bulk_unit="piece",
        total_cost=batch_pcs * cost_per_pc, cost_per_base_unit=cost_per_pc,
        quantity_remaining=batch_pcs,
        date_received=datetime.now(timezone.utc) - timedelta(days=1),
        status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return attendant, product, batch


def _sync(app, token, items):
    """POST /api/sales/sync with a list of items; returns per-uuid results."""
    with app.test_client() as client:
        res = client.post("/api/sales/sync", json={"sales": items},
                          headers={"Authorization": f"Bearer {token}"})
    return res.status_code, res.get_json()


def _sync_item(uuid, product, attendant, qty, unit, price, amount=None,
               count=None, sale_uuid=None, button_label=None, created_at=None):
    item = {
        "client_uuid": uuid,
        "product_id": product.id,
        "attendant_id": attendant.id,
        "quantity_sold": qty,
        "unit_sold_in": unit,
        "price_charged": price,
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
    }
    if amount is not None:
        item["amount_in_base_unit"] = amount
    if count is not None:
        item["count"] = count
    if sale_uuid is not None:
        item["sale_uuid"] = sale_uuid
    if button_label is not None:
        item["button_label"] = button_label
    return item


def _cleanup(tmpdir: str) -> None:
    for f in os.listdir(tmpdir):
        try:
            os.remove(os.path.join(tmpdir, f))
        except OSError:
            pass
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass


def test_1_tomato_count_3():
    """1 tomato @ KSh5 x3 → quantity_base 3, revenue 15, cost 6, profit 9, stock 97."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        # Exactly what the offline queue re-sends after reload: qty = amount x
        # count, price per base unit, amount = qty, count preserved.
        code, body = _sync(app, token, [_sync_item(
            "t1-x3", product, attendant, 3, "piece", 5.0, amount=3, count=3,
            sale_uuid="cart1", button_label="1 @ KSh5",
        )])
        r = body["results"][0]
        checks.check(code == 200 and r["status"] == "synced", f"counted count sale syncs ({r.get('status')})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, f"stock 100 -> 97 ({batch.quantity_remaining})")

        sale = Sale.query.filter_by(client_uuid="t1-x3").first()
        checks.check(abs(sale.quantity_base - 3.0) < 1e-9, f"quantity_base == 3 ({sale.quantity_base})")
        checks.check(abs(sale.revenue - 15.0) < 1e-9, f"revenue == KSh 15 (3 x 5, not the 3-piece button) ({sale.revenue})")
        checks.check(abs(sale.cost_at_sale - 2.0) < 1e-9, f"cost_at_sale == KSh 2/piece ({sale.cost_at_sale})")
        checks.check(abs(sale.profit - 9.0) < 1e-9, f"profit == KSh 9 ({sale.profit})")
        checks.check(sale.button_count_snapshot == 3, f"count snapshotted as 3 ({sale.button_count_snapshot})")
        checks.check(sale.button_label_snapshot == "1 @ KSh5", "button label snapshotted")
    _cleanup(tmpdir)
    checks.done()


def test_3_tomatoes_count_2():
    """3 tomatoes @ KSh10 x2 → 6 pieces, revenue 20, cost 12, profit 8, stock 94."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        code, body = _sync(app, token, [_sync_item(
            "b3-x2", product, attendant, 6, "piece", 10 / 3, amount=6, count=2,
            sale_uuid="cart2", button_label="3 @ KSh10",
        )])
        r = body["results"][0]
        checks.check(r["status"] == "synced", f"bundle x2 syncs ({r.get('status')})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 94.0) < 1e-9, f"stock 100 -> 94 ({batch.quantity_remaining})")

        sale = Sale.query.filter_by(client_uuid="b3-x2").first()
        checks.check(abs(sale.quantity_base - 6.0) < 1e-9, f"quantity_base == 6 = 3 x 2 ({sale.quantity_base})")
        checks.check(abs(sale.revenue - 20.0) < 1e-9, f"revenue == KSh 20 = price x count ({sale.revenue})")
        checks.check(abs(sale.profit - 8.0) < 1e-9, f"profit == KSh 8 ({sale.profit})")
        checks.check(sale.button_count_snapshot == 2, f"count snapshotted as 2 ({sale.button_count_snapshot})")
    _cleanup(tmpdir)
    checks.done()


def test_count_never_confuses_button_amount():
    """'1 tomato' x3 and '3 tomatoes' x1 both consume 3 pieces but are
    different sales: different labels, counts (3 vs 1), prices (15 vs 10)."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        _sync(app, token, [_sync_item(
            "one-x3", product, attendant, 3, "piece", 5.0, amount=3, count=3,
            sale_uuid="cA", button_label="1 @ KSh5",
        )])
        _sync(app, token, [_sync_item(
            "three-x1", product, attendant, 3, "piece", 10 / 3, amount=3, count=1,
            sale_uuid="cB", button_label="3 @ KSh10",
        )])

        a = Sale.query.filter_by(client_uuid="one-x3").first()
        b = Sale.query.filter_by(client_uuid="three-x1").first()
        checks.check(abs(a.quantity_base - 3.0) < 1e-9 and abs(b.quantity_base - 3.0) < 1e-9, "both consume 3 pieces")
        checks.check(a.button_count_snapshot == 3 and b.button_count_snapshot == 1, "counts differ (3 vs 1)")
        checks.check(a.button_label_snapshot == "1 @ KSh5" and b.button_label_snapshot == "3 @ KSh10", "labels differ")
        checks.check(abs(a.revenue - 15.0) < 1e-9 and abs(b.revenue - 10.0) < 1e-9,
                     f"revenues differ: 15 vs 10 ({a.revenue}, {b.revenue})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 94.0) < 1e-9, "6 pieces deducted total")
    _cleanup(tmpdir)
    checks.done()


def test_rice_quarter_kg_times_two():
    """Pishori 1/4 kg @ KSh40 x2 → 0.5 kg, revenue KSh 80 (2 x the button,
    never the 1/2 kg @ KSh75 price). Count applies to weighed buttons too."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant = _seed_attendant()
        product = Product(
            name="Pishori Rice", category=Category.dry, base_unit=BaseUnit.kg,
            pricing_mode=PricingMode.weighed, sell_price=140.0, reorder_threshold=2.0,
        )
        db.session.add(product)
        db.session.flush()
        product.price_buttons = [
            PriceButton(label="1/4 kg", kg_amount=0.25, price=40, sort_order=0),
            PriceButton(label="1/2 kg", kg_amount=0.5, price=75, sort_order=1),
            PriceButton(label="1 kg", kg_amount=1.0, price=140, sort_order=2),
        ]
        batch = StockBatch(
            product_id=product.id, bulk_quantity=10, bulk_unit="kg", total_cost=1000,
            cost_per_base_unit=100.0, quantity_remaining=10,
            date_received=datetime.now(timezone.utc) - timedelta(days=1),
            status=BatchStatus.open,
        )
        db.session.add(batch)
        db.session.commit()
        token = _mk_token(attendant.id)

        code, body = _sync(app, token, [_sync_item(
            "q-x2", product, attendant, 0.5, "kg", 40 / 0.25, count=2,
            sale_uuid="rice", button_label="1/4 kg",
        )])
        r = body["results"][0]
        checks.check(r["status"] == "synced", f"1/4 kg x2 syncs ({r.get('status')})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 9.5) < 1e-9, f"stock 10 -> 9.5 ({batch.quantity_remaining})")
        sale = Sale.query.filter_by(client_uuid="q-x2").first()
        checks.check(abs(sale.quantity_base - 0.5) < 1e-9, f"quantity_base == 0.5 kg ({sale.quantity_base})")
        checks.check(abs(sale.revenue - 80.0) < 1e-9, f"revenue == KSh 80 (2 x 40) ({sale.revenue})")
        checks.check(abs(sale.profit - 30.0) < 1e-9, f"profit == KSh 80 - 0.5kg x 100 ({sale.profit})")
        checks.check(sale.button_count_snapshot == 2, f"count snapshotted as 2 ({sale.button_count_snapshot})")
    _cleanup(tmpdir)
    checks.done()


def test_legacy_counted_button_with_count():
    """A legacy counted button (kg_amount NULL) sold with a count keeps the
    estimate path: no deduction, no per-sale cost/profit — but revenue is the
    price x count and the count is snapshotted."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        # Replace buttons with a legacy amount-less option.
        product.price_buttons = [PriceButton(label="3 @ KSh10", kg_amount=None, price=10, sort_order=0)]
        db.session.commit()
        token = _mk_token(attendant.id)

        # Legacy path: no amount_in_base_unit sent; qty = count (times sold).
        code, body = _sync(app, token, [_sync_item(
            "legacy-x3", product, attendant, 3, "piece", 10.0, count=3,
            sale_uuid="legacy", button_label="3 @ KSh10",
        )])
        r = body["results"][0]
        checks.check(r["status"] == "synced", f"legacy counted x3 syncs ({r.get('status')})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 100.0) < 1e-9, "no stock deducted (legacy estimate)")
        sale = Sale.query.filter_by(client_uuid="legacy-x3").first()
        checks.check(sale.quantity_base is None, "quantity_base NULL for legacy counted")
        checks.check(abs(sale.revenue - 30.0) < 1e-9, f"revenue == KSh 30 = 3 x 10 ({sale.revenue})")
        checks.check(sale.cost_at_sale == 0.0 and sale.profit == 0.0, "no per-sale cost/profit")
        checks.check(sale.button_count_snapshot == 3, f"count still snapshotted ({sale.button_count_snapshot})")
        checks.check(abs(batch.revenue_so_far - 30.0) < 1e-9, "legacy revenue on the batch P&L")
    _cleanup(tmpdir)
    checks.done()


def test_tracked_counted_margin_appears_on_dashboard():
    """A tracked counted sale (amount set) shows real revenue/cost/profit/margin
    on the dashboard — it is NOT a zero-margin counted sale. A product that
    only ever sold legacy estimate buttons stays 'sold by piece' (margin null),
    and a tracked low-margin sale is flagged."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, tomatoes, t_batch = _seed_tomatoes(batch_pcs=100, cost_per_pc=4.8)

        # A second counted product that will only have LEGACY sales.
        legacy = Product(
            name="Legacy Garlic", category=Category.produce, base_unit=BaseUnit.piece,
            pricing_mode=PricingMode.counted, sell_price=0.0, reorder_threshold=5.0,
        )
        db.session.add(legacy)
        db.session.flush()
        legacy.price_buttons = [PriceButton(label="1 @ KSh10", kg_amount=None, price=10, sort_order=0)]
        l_batch = StockBatch(
            product_id=legacy.id, bulk_quantity=50, bulk_unit="piece", total_cost=100,
            cost_per_base_unit=2.0, quantity_remaining=50,
            date_received=datetime.now(timezone.utc) - timedelta(days=1), status=BatchStatus.open,
        )
        db.session.add(l_batch)
        db.session.commit()
        token = _mk_token(attendant.id)

        # Tracked counted sale: 1 tomato @ KSh5, cost 4.8/piece -> profit 0.2,
        # margin 4% — below the 10% threshold, must be flagged.
        _sync(app, token, [_sync_item(
            "dash-t1", tomatoes, attendant, 1, "piece", 5.0, amount=1, count=1,
            sale_uuid="d1", button_label="1 @ KSh5",
        )])
        # Legacy counted sale.
        _sync(app, token, [_sync_item("dash-leg", legacy, attendant, 1, "piece", 10.0)])

        with app.test_client() as client:
            body = client.get("/api/dashboard/summary", headers={"Authorization": f"Bearer {token}"}).get_json()

        checks.check(abs(body["today"]["revenue"] - 15.0) < 1e-9, f"today revenue includes both ({body['today']['revenue']})")
        checks.check(abs(body["today"]["cost"] - 4.8) < 1e-9, f"today cost includes tracked counted FIFO cost ({body['today']['cost']})")
        checks.check(abs(body["today"]["profit"] - 0.2) < 1e-9, f"today profit includes tracked counted profit ({body['today']['profit']})")

        per_product = {p["product_id"]: p for p in body["per_product"]}
        t = per_product[tomatoes.id]
        checks.check(t["margin_pct"] is not None and abs(t["margin_pct"] - 0.04) < 1e-6,
                     f"tracked counted product gets a real margin ({t['margin_pct']})")
        checks.check(t["low_margin"] is True, "tracked counted low-margin sale flagged")
        checks.check(abs(t["cost"] - 4.8) < 1e-9, f"tracked counted product cost shown ({t['cost']})")

        l = per_product[legacy.id]
        checks.check(l["margin_pct"] is None, f"pure-legacy counted product stays margin-less ({l['margin_pct']})")

        uuids = [s["client_uuid"] for s in body["low_margin_sales"]]
        checks.check("dash-t1" in uuids, "tracked counted low-margin sale appears in low_margin_sales")
        checks.check("dash-leg" not in uuids, "legacy counted sale never flagged")
    _cleanup(tmpdir)
    checks.done()


def test_attendant_cannot_attribute_sales_to_another():
    """An attendant's session can only record sales under themselves — a
    forged payload attendant_id is ignored; the JWT identity wins. The owner
    (who PIN-verifies at the till) may still attribute to another attendant."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        owner = _seed_attendant(ShopRole.owner)
        staff = _seed_attendant(ShopRole.attendant)
        product, batch = _seed_tomatoes()[1:]
        db.session.commit()
        staff_token = _mk_token(staff.id, "attendant")

        forged = _sync_item(
            "forged-attrib", product, staff, 1, "piece", 5.0, amount=1, count=1,
            sale_uuid="f1", button_label="1 @ KSh5",
        )
        forged["attendant_id"] = 999  # forged — must be ignored
        code, body = _sync(app, staff_token, [forged])
        r = body["results"][0]
        checks.check(code == 200 and r["status"] == "synced", f"attendant sale syncs ({r.get('status')})")
        sale = Sale.query.filter_by(client_uuid="forged-attrib").first()
        checks.check(sale.attendant_id == staff.id, f"attributed to JWT identity, not the forged id ({sale.attendant_id})")

        # Owner may attribute to an attendant (PIN-verified at the till).
        owner_token = _mk_token(owner.id, "owner")
        owner_item = _sync_item(
            "owner-attrib", product, staff, 1, "piece", 5.0, amount=1, count=1,
            sale_uuid="f2", button_label="1 @ KSh5",
        )
        _sync(app, owner_token, [owner_item])
        sale2 = Sale.query.filter_by(client_uuid="owner-attrib").first()
        checks.check(sale2.attendant_id == staff.id, f"owner can ring under an attendant ({sale2.attendant_id})")
    _cleanup(tmpdir)
    checks.done()


def test_offline_style_retry_does_not_double_deduct():
    """The offline queue re-sends the exact item (qty = amount x count, count
    preserved) after a reload; the retry must ack as a duplicate with no
    second deduction — the count never inflates stock loss."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        item = _sync_item(
            "offline-x3", product, attendant, 3, "piece", 5.0, amount=3, count=3,
            sale_uuid="o1", button_label="1 @ KSh5",
        )
        code, body = _sync(app, token, [item])
        r1 = body["results"][0]
        checks.check(r1["status"] == "synced", f"first send commits ({r1.get('status')})")

        # App died before the ack; reload; reconnect; sync sends the same item.
        code2, body2 = _sync(app, token, [item])
        r2 = body2["results"][0]
        checks.check(r2["status"] == "duplicate", f"retry dedups ({r2.get('status')})")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, "stock deducted exactly once (97 left)")
        checks.check(Sale.query.filter_by(client_uuid="offline-x3").count() == 1, "one sale row for the uuid")
    _cleanup(tmpdir)
    checks.done()


def test_final_regression_offline_count_five():
    """Part 9 final regression, offline leg: stock 100 @ KSh2, sell
    '1 tomato @ KSh5' x5 offline-style -> 5 pcs, revenue KSh 25, FIFO cost
    KSh 10, profit KSh 15, stock 95. The same payload re-sent after a reload
    (reconnect) must dedup as a duplicate with NO second deduction."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        item = _sync_item(
            "reg-offline-5", product, attendant, 5, "piece", 5.0, amount=5, count=5,
            sale_uuid="reg-cart", button_label="1 tomato",
        )
        code, body = _sync(app, token, [item])
        r = body["results"][0]
        checks.check(code == 200 and r["status"] == "synced", f"offline count-5 syncs ({r.get('status')})")

        sale = Sale.query.filter_by(client_uuid="reg-offline-5").first()
        checks.check(abs(sale.quantity_base - 5.0) < 1e-9, f"quantity_base == 5 ({sale.quantity_base})")
        checks.check(abs(sale.revenue - 25.0) < 1e-9, f"revenue == KSh 25 = 5 x 5 ({sale.revenue})")
        checks.check(abs(sale.cost_at_sale - 2.0) < 1e-9 and abs(sale.profit - 15.0) < 1e-9,
                     f"cost 2/pc, profit 15 ({sale.cost_at_sale}, {sale.profit})")
        checks.check(sale.button_count_snapshot == 5, f"count snapshotted as 5 ({sale.button_count_snapshot})")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 95.0) < 1e-9, f"stock 100 -> 95 ({batch.quantity_remaining})")

        # Reload + reconnect: the queue re-sends the identical payload.
        code2, body2 = _sync(app, token, [item])
        r2 = body2["results"][0]
        checks.check(r2["status"] == "duplicate", f"reconnect retry dedups ({r2.get('status')})")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 95.0) < 1e-9, "stock deducted exactly once")
        checks.check(Sale.query.filter_by(client_uuid="reg-offline-5").count() == 1, "single sale row — no duplicate")
    _cleanup(tmpdir)
    checks.done()


def test_acceptance_scenario():
    """Part 24 — the complete scenario through the real API:

    - create Tomatoes (counted, piece) with buttons 1/3/6 via the API
    - stock 100 pieces @ KSh 2 each
    - sell '1 tomato @ KSh5' x3  -> 3 pcs, KSh15, cost 6, profit 9, stock 97
    - sell '3 tomatoes @ KSh10' x2 -> 6 pcs, KSh20, cost 12, profit 8, stock 91
    - dashboard: revenue 35, cost 18, profit 17
    - sales page shows both transactions with count snapshots
    - void the second -> stock 97, first untouched
    """
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant = _seed_attendant()
        token = _mk_token(attendant.id)

        # --- Create the product through the real API (Part 8 contract) ---
        with app.test_client() as client:
            res = client.post("/api/products", json={
                "name": "Tomatoes", "category": "produce", "base_unit": "piece",
                "pricing_mode": "counted",
                "price_buttons": [
                    {"label": "1 tomato", "kg_amount": 1, "price": 5, "sort_order": 0},
                    {"label": "3 tomatoes", "kg_amount": 3, "price": 10, "sort_order": 1},
                    {"label": "6 tomatoes", "kg_amount": 6, "price": 20, "sort_order": 2},
                ],
            }, headers={"Authorization": f"Bearer {token}"})
            checks.check(res.status_code == 201, f"product created via API: HTTP {res.status_code}")
            product_id = res.get_json()["id"]

            # Reload the product — button amounts must survive the round trip.
            listed = client.get("/api/products", headers={"Authorization": f"Bearer {token}"}).get_json()
        product = db.session.get(Product, product_id)
        db.session.refresh(product)
        fetched = next(p for p in listed if p["id"] == product_id)
        three_btn = next(b for b in fetched["price_buttons"] if b["label"] == "3 tomatoes")
        checks.check(three_btn["kg_amount"] == 3 and three_btn["price"] == 10,
                     f"'3 tomatoes' amount 3 / KSh 10 survives API round trip ({three_btn})")

        # --- Stock: 100 pieces @ KSh 2 each ---
        with app.test_client() as client:
            res = client.post("/api/batches", json={
                "product_id": product_id, "bulk_quantity": 100, "bulk_unit": "piece",
                "total_cost": 200,
            }, headers={"Authorization": f"Bearer {token}"})
            checks.check(res.status_code == 201, f"batch created: HTTP {res.status_code}")

        # --- Sale 1: 1 tomato @ KSh5 x3 ---
        code, body = _sync(app, token, [_sync_item(
            "acc-1", product, attendant, 3, "piece", 5.0, amount=3, count=3,
            sale_uuid="acc-cart-1", button_label="1 tomato",
        )])
        checks.check(body["results"][0]["status"] == "synced", "sale 1 syncs")
        s1 = Sale.query.filter_by(client_uuid="acc-1").first()
        db.session.refresh(product)
        checks.check(abs(s1.quantity_base - 3.0) < 1e-9 and abs(s1.revenue - 15.0) < 1e-9
                     and abs(s1.profit - 9.0) < 1e-9, f"sale 1: qty 3, rev 15, profit 9 ({s1.revenue}, {s1.profit})")

        # --- Sale 2: 3 tomatoes @ KSh10 x2 ---
        code, body = _sync(app, token, [_sync_item(
            "acc-2", product, attendant, 6, "piece", 10 / 3, amount=6, count=2,
            sale_uuid="acc-cart-2", button_label="3 tomatoes",
        )])
        checks.check(body["results"][0]["status"] == "synced", "sale 2 syncs")
        s2 = Sale.query.filter_by(client_uuid="acc-2").first()
        checks.check(abs(s2.quantity_base - 6.0) < 1e-9 and abs(s2.revenue - 20.0) < 1e-9
                     and abs(s2.profit - 8.0) < 1e-9, f"sale 2: qty 6, rev 20, profit 8 ({s2.revenue}, {s2.profit})")
        db.session.refresh(product)
        checks.check(abs(product.total_stock - 91.0) < 1e-9, f"9 pieces consumed, 91 left ({product.total_stock})")

        # --- Dashboard includes both before the void ---
        with app.test_client() as client:
            dash = client.get("/api/dashboard/summary", headers={"Authorization": f"Bearer {token}"}).get_json()
        checks.check(abs(dash["today"]["revenue"] - 35.0) < 1e-9, f"dashboard revenue 35 ({dash['today']['revenue']})")
        checks.check(abs(dash["today"]["cost"] - 18.0) < 1e-9, f"dashboard cost 18 ({dash['today']['cost']})")
        checks.check(abs(dash["today"]["profit"] - 17.0) < 1e-9, f"dashboard profit 17 ({dash['today']['profit']})")

        # --- Sales page: both transactions, count snapshots intact ---
        with app.test_client() as client:
            page = client.get("/api/sales/page?page=1&per_page=50", headers={"Authorization": f"Bearer {token}"}).get_json()
        rows = {r["client_uuid"]: r for r in page["items"]}
        checks.check("acc-1" in rows and "acc-2" in rows, "both sales on the sales page")
        checks.check(rows["acc-1"]["button_count_snapshot"] == 3 and rows["acc-1"]["button_label_snapshot"] == "1 tomato",
                     "sale 1 history shows 3 x '1 tomato'")
        checks.check(rows["acc-2"]["button_count_snapshot"] == 2 and rows["acc-2"]["button_label_snapshot"] == "3 tomatoes",
                     "sale 2 history shows 2 x '3 tomatoes'")

        # --- Void the SECOND transaction: 6 pieces restored, first untouched ---
        with app.test_client() as client:
            res = client.post(f"/api/sales/{s2.id}/void", headers={"Authorization": f"Bearer {token}"})
            checks.check(res.status_code == 200, f"void sale 2: HTTP {res.status_code}")
        db.session.refresh(product)
        checks.check(abs(product.total_stock - 97.0) < 1e-9, f"6 pieces restored, 97 left ({product.total_stock})")
        db.session.refresh(s1)
        db.session.refresh(s2)
        checks.check(s2.voided_at is not None, "sale 2 marked voided")
        checks.check(s1.voided_at is None, "sale 1 untouched")
    _cleanup(tmpdir)
    checks.done()


if __name__ == "__main__":
    test_1_tomato_count_3()
    test_3_tomatoes_count_2()
    test_count_never_confuses_button_amount()
    test_rice_quarter_kg_times_two()
    test_legacy_counted_button_with_count()
    test_tracked_counted_margin_appears_on_dashboard()
    test_attendant_cannot_attribute_sales_to_another()
    test_offline_style_retry_does_not_double_deduct()
    test_final_regression_offline_count_five()
    test_acceptance_scenario()
