"""
Regression tests — counted products with amounts consume real stock.

A counted selling option with an amount ("3 tomatoes" → 3 pieces) must route
through the exact same FIFO accounting as weighed products: precise deduction,
revenue exactly the fixed button price, and cost/profit computed server-side.
Legacy counted options without an amount keep the old untracked estimate
behavior (no deduction, batch-level P&L).

Run from anywhere:
    python3 backend/tests/test_counted_tracking.py

No pytest needed — plain asserts with a standalone main, mirroring
test_stock_guard.py's isolated-DB pattern.
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


def _seed_attendant():
    attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
    db.session.add(attendant)
    db.session.flush()
    return attendant


def _seed_tomatoes(batch_pcs=100.0, cost_per_pc=2.0, buttons=True):
    """Counted product, base unit piece, tracked buttons 1/3/6 (or none)."""
    attendant = _seed_attendant()
    product = Product(
        name="Tomatoes",
        category=Category.produce,
        base_unit=BaseUnit.piece,
        pricing_mode=PricingMode.counted,
        sell_price=0.0,
        reorder_threshold=10.0,
    )
    db.session.add(product)
    db.session.flush()
    if buttons:
        product.price_buttons = [
            PriceButton(label="1 @ KSh5", kg_amount=1, price=5, sort_order=0),
            PriceButton(label="3 @ KSh10", kg_amount=3, price=10, sort_order=1),
            PriceButton(label="6 @ KSh20", kg_amount=6, price=20, sort_order=2),
        ]
    batch = None
    if batch_pcs > 0:
        batch = StockBatch(
            product_id=product.id,
            bulk_quantity=batch_pcs,
            bulk_unit="piece",
            total_cost=batch_pcs * cost_per_pc,
            cost_per_base_unit=cost_per_pc,
            quantity_remaining=batch_pcs,
            date_received=datetime.now(timezone.utc) - timedelta(days=1),
            status=BatchStatus.open,
        )
        db.session.add(batch)
    db.session.commit()
    return attendant, product, batch


def _seed_weighed_rice(kg=10.0, cost_per_kg=100.0):
    attendant = _seed_attendant()
    product = Product(
        name="Pishori Rice",
        category=Category.dry,
        base_unit=BaseUnit.kg,
        pricing_mode=PricingMode.weighed,
        sell_price=140.0,
        reorder_threshold=2.0,
    )
    db.session.add(product)
    db.session.flush()
    product.price_buttons = [
        PriceButton(label="1/4 kg", kg_amount=0.25, price=40, sort_order=0),
        PriceButton(label="1/2 kg", kg_amount=0.5, price=75, sort_order=1),
        PriceButton(label="1 kg", kg_amount=1.0, price=140, sort_order=2),
    ]
    batch = StockBatch(
        product_id=product.id,
        bulk_quantity=kg,
        bulk_unit="kg",
        total_cost=kg * cost_per_kg,
        cost_per_base_unit=cost_per_kg,
        quantity_remaining=kg,
        date_received=datetime.now(timezone.utc) - timedelta(days=1),
        status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return attendant, product, batch


def _sync_one(app, token, uuid, product, attendant, qty, unit, price, amount=None, sale_uuid=None, button_label=None):
    item = {
        "client_uuid": uuid,
        "product_id": product.id,
        "attendant_id": attendant.id,
        "quantity_sold": qty,
        "unit_sold_in": unit,
        "price_charged": price,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if amount is not None:
        item["amount_in_base_unit"] = amount
    if sale_uuid is not None:
        item["sale_uuid"] = sale_uuid
    if button_label is not None:
        item["button_label"] = button_label
    with app.test_client() as client:
        res = client.post(
            "/api/sales/sync",
            json={"sales": [item]},
            headers={"Authorization": f"Bearer {token}"},
        )
    return res.get_json()["results"][0]


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


def test_3_tomatoes_deducts_3_pieces():
    """The core fix: a counted bundle with an amount deducts its exact amount
    and earns exactly the fixed price, with server-computed cost/profit."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        r = _sync_one(app, token, "bundle-3", product, attendant, 3, "piece", 10 / 3, amount=3, button_label="3 @ KSh10")
        checks.check(r["status"] == "synced", f"3-piece bundle syncs: {r.get('status')}")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, f"stock deducted exactly 3 -> {batch.quantity_remaining}")

        sale = Sale.query.filter_by(client_uuid="bundle-3").first()
        checks.check(sale is not None, "sale row created")
        if sale is not None:
            checks.check(abs(sale.quantity_base - 3.0) < 1e-9, f"quantity_base == 3 ({sale.quantity_base})")
            checks.check(abs(sale.revenue - 10.0) < 1e-9, f"revenue == KSh 10.00 ({sale.revenue})")
            checks.check(round(sale.revenue, 2) == 10.0, "display revenue rounds to 10.00")
            checks.check(abs(sale.cost_at_sale - 2.0) < 1e-9, f"cost_at_sale == KSh 2/piece ({sale.cost_at_sale})")
            checks.check(abs(sale.profit - 4.0) < 1e-9, f"profit == KSh 4.00 ({sale.profit})")
            checks.check(sale.unit_sold_in == "piece", f"unit_sold_in == piece ({sale.unit_sold_in})")
            checks.check(sale.button_label_snapshot == "3 @ KSh10", f"button label snapshotted ({sale.button_label_snapshot})")
            checks.check(sale.product_name_snapshot == "Tomatoes", f"product name snapshotted ({sale.product_name_snapshot})")
    _cleanup(tmpdir)
    checks.done()


def test_single_and_six_options():
    """1 tomato @ KSh5 and 6 tomatoes @ KSh20 each deduct exactly their amount."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        r1 = _sync_one(app, token, "single-1", product, attendant, 1, "piece", 5.0, amount=1, button_label="1 @ KSh5")
        r2 = _sync_one(app, token, "six-6", product, attendant, 6, "piece", 20 / 6, amount=6, button_label="6 @ KSh20")
        checks.check(r1["status"] == "synced" and r2["status"] == "synced", "both options sync")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 93.0) < 1e-9, f"7 pieces deducted total -> {batch.quantity_remaining}")

        s1 = Sale.query.filter_by(client_uuid="single-1").first()
        s2 = Sale.query.filter_by(client_uuid="six-6").first()
        checks.check(abs(s1.revenue - 5.0) < 1e-9 and abs(s1.profit - 3.0) < 1e-9, f"1 pc: revenue 5, profit 3 ({s1.revenue}, {s1.profit})")
        checks.check(abs(s2.revenue - 20.0) < 1e-9 and abs(s2.profit - 8.0) < 1e-9, f"6 pc: revenue 20, profit 8 ({s2.revenue}, {s2.profit})")
    _cleanup(tmpdir)
    checks.done()


def test_nonlinear_bundle_revenue_exact():
    """Non-linear pricing: revenue is the button price, never quantity × unit price."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        _sync_one(app, token, "nl-1", product, attendant, 1, "piece", 5.0, amount=1)
        _sync_one(app, token, "nl-3", product, attendant, 3, "piece", 10 / 3, amount=3)
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 96.0) < 1e-9, "4 pieces deducted")
        total_rev = sum(s.revenue for s in Sale.query.all())
        total_profit = sum(s.profit for s in Sale.query.all())
        checks.check(abs(total_rev - 15.0) < 1e-9, f"combined revenue exactly 15.00 ({total_rev})")
        checks.check(abs(total_profit - 7.0) < 1e-9, f"combined profit exactly 7.00 ({total_profit})")
    _cleanup(tmpdir)
    checks.done()


def test_bundle_crosses_batches():
    """Batch A (2 pc @1) then batch B (10 pc @2): a 3-piece bundle consumes
    2 from A and 1 from B; allocations and weighted cost stay exact."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, _ = _seed_tomatoes(batch_pcs=0)  # reuse for product only
        now = datetime.now(timezone.utc)
        a = StockBatch(
            product_id=product.id, bulk_quantity=2, bulk_unit="piece", total_cost=2,
            cost_per_base_unit=1.0, quantity_remaining=2, date_received=now - timedelta(days=2), status=BatchStatus.open,
        )
        b = StockBatch(
            product_id=product.id, bulk_quantity=10, bulk_unit="piece", total_cost=20,
            cost_per_base_unit=2.0, quantity_remaining=10, date_received=now - timedelta(days=1), status=BatchStatus.open,
        )
        db.session.add_all([a, b])
        db.session.commit()
        token = _mk_token(attendant.id)

        r = _sync_one(app, token, "cross-batch", product, attendant, 3, "piece", 10 / 3, amount=3)
        checks.check(r["status"] == "synced", f"cross-batch bundle syncs: {r.get('status')}")

        db.session.refresh(a)
        db.session.refresh(b)
        checks.check(abs(a.quantity_remaining - 0.0) < 1e-9 and a.status == BatchStatus.closed, "batch A drained and auto-closed")
        checks.check(abs(b.quantity_remaining - 9.0) < 1e-9, f"batch B supplies 1 -> {b.quantity_remaining}")

        sale = Sale.query.filter_by(client_uuid="cross-batch").first()
        checks.check(
            sale.batch_allocations == [{"batch_id": a.id, "qty": 2.0}, {"batch_id": b.id, "qty": 1.0}],
            f"exact allocations recorded: {sale.batch_allocations}",
        )
        # weighted cost = (2*1 + 1*2)/3 = 4/3 per piece; profit = 10 - 4 = 6
        checks.check(abs(sale.cost_at_sale - (4 / 3)) < 1e-9, f"weighted cost per piece ({sale.cost_at_sale})")
        checks.check(abs(sale.profit - 6.0) < 1e-9, f"profit == 6.00 ({sale.profit})")
    _cleanup(tmpdir)
    checks.done()


def test_legacy_counted_null_amount_backward_compatible():
    """Counted options without an amount keep the old behavior exactly:
    no deduction, cost/profit 0 at sale level, revenue on the batch P&L."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes(buttons=False)
        product.price_buttons = [
            PriceButton(label="3 @ KSh10", kg_amount=None, price=10, sort_order=0),
        ]
        db.session.commit()
        token = _mk_token(attendant.id)

        # No amount_in_base_unit sent — legacy estimate path.
        r = _sync_one(app, token, "legacy-3", product, attendant, 1, "piece", 10.0)
        checks.check(r["status"] == "synced", f"legacy counted sale syncs: {r.get('status')}")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 100.0) < 1e-9, "no stock deducted for legacy counted")
        sale = Sale.query.filter_by(client_uuid="legacy-3").first()
        checks.check(sale.quantity_base is None, "quantity_base NULL for legacy counted")
        checks.check(sale.cost_at_sale == 0.0 and sale.profit == 0.0, "no per-sale cost/profit for legacy counted")
        checks.check(abs(batch.revenue_so_far - 10.0) < 1e-9, "legacy revenue stays on the batch P&L")
    _cleanup(tmpdir)
    checks.done()


def test_rice_portions_deduct_exact_kg():
    """1/4 kg @ KSh40 → 0.25 kg deducted, cost KSh25, profit KSh15 (10 kg @ 100)."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_weighed_rice()
        token = _mk_token(attendant.id)

        r = _sync_one(app, token, "rice-q", product, attendant, 0.25, "kg", 40 / 0.25, button_label="1/4 kg")
        checks.check(r["status"] == "synced", f"1/4 kg sale syncs: {r.get('status')}")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 9.75) < 1e-9, f"stock 10 -> 9.75 ({batch.quantity_remaining})")
        sale = Sale.query.filter_by(client_uuid="rice-q").first()
        checks.check(abs(sale.revenue - 40.0) < 1e-9, f"revenue == 40.00 ({sale.revenue})")
        checks.check(abs(sale.cost_at_sale - 100.0) < 1e-9, f"cost_at_sale == 100/kg ({sale.cost_at_sale})")
        checks.check(abs(sale.profit - 15.0) < 1e-9, f"profit == 15.00 ({sale.profit})")
        checks.check(abs(sale.quantity_base - 0.25) < 1e-9, f"quantity_base == 0.25 ({sale.quantity_base})")

        # 1/2 kg @ KSh75 and 1 kg @ KSh140 must not contaminate the first line.
        _sync_one(app, token, "rice-h", product, attendant, 0.5, "kg", 75 / 0.5, button_label="1/2 kg")
        _sync_one(app, token, "rice-k", product, attendant, 1.0, "kg", 140.0, button_label="1 kg")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 8.25) < 1e-9, f"stock 9.75 -> 8.25 after 0.5+1 kg ({batch.quantity_remaining})")
        h = Sale.query.filter_by(client_uuid="rice-h").first()
        k = Sale.query.filter_by(client_uuid="rice-k").first()
        checks.check(abs(h.revenue - 75.0) < 1e-9 and abs(h.profit - 25.0) < 1e-9, f"half kg: rev 75, profit 25 ({h.revenue}, {h.profit})")
        checks.check(abs(k.revenue - 140.0) < 1e-9 and abs(k.profit - 40.0) < 1e-9, f"1 kg: rev 140, profit 40 ({k.revenue}, {k.profit})")
    _cleanup(tmpdir)
    checks.done()


def test_brands_have_independent_stock():
    """Two rice brands never touch each other's batches or cost."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, pishori, b_pishori = _seed_weighed_rice(kg=10, cost_per_kg=100)
        brand_b = Product(
            name="Brand B Rice", category=Category.dry, base_unit=BaseUnit.kg,
            pricing_mode=PricingMode.weighed, sell_price=180.0, reorder_threshold=2.0,
        )
        db.session.add(brand_b)
        db.session.flush()
        brand_b.price_buttons = [PriceButton(label="1/4 kg", kg_amount=0.25, price=45, sort_order=0)]
        b_brand = StockBatch(
            product_id=brand_b.id, bulk_quantity=8, bulk_unit="kg", total_cost=8 * 120,
            cost_per_base_unit=120.0, quantity_remaining=8,
            date_received=datetime.now(timezone.utc) - timedelta(days=1), status=BatchStatus.open,
        )
        db.session.add(b_brand)
        db.session.commit()
        token = _mk_token(attendant.id)

        _sync_one(app, token, "bb-1", brand_b, attendant, 0.25, "kg", 45 / 0.25, button_label="1/4 kg")
        db.session.refresh(b_pishori)
        db.session.refresh(b_brand)
        checks.check(abs(b_pishori.quantity_remaining - 10.0) < 1e-9, "Pishori stock untouched")
        checks.check(abs(b_brand.quantity_remaining - 7.75) < 1e-9, "Brand B stock deducted only its own")
        bb = Sale.query.filter_by(client_uuid="bb-1").first()
        checks.check(abs(bb.cost_at_sale - 120.0) < 1e-9, f"Brand B cost uses its own batch ({bb.cost_at_sale})")
        checks.check(abs(bb.profit - (45 - 120 * 0.25)) < 1e-9, f"Brand B profit from its own cost ({bb.profit})")
    _cleanup(tmpdir)
    checks.done()


def test_counted_create_requires_amounts():
    """New counted products must define amounts; legacy edit may keep NULL."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant = _seed_attendant()
        token = _mk_token(attendant.id)

        with app.test_client() as client:
            # Create with an amountless counted button -> 422
            bad = client.post("/api/products", json={
                "name": "Garlic", "category": "produce", "base_unit": "piece",
                "pricing_mode": "counted",
                "price_buttons": [{"label": "3 @ KSh20", "kg_amount": None, "price": 20, "sort_order": 0}],
            }, headers={"Authorization": f"Bearer {token}"})
            checks.check(bad.status_code == 422, f"counted create without amounts rejected: HTTP {bad.status_code}")
            checks.check(
                "needs an amount" in bad.get_json().get("errors", {}).get("price_buttons", ""),
                f"reason names the missing amount: {bad.get_json()['errors']}",
            )

            # Create with amounts -> 201
            ok = client.post("/api/products", json={
                "name": "Tomatoes", "category": "produce", "base_unit": "piece",
                "pricing_mode": "counted",
                "price_buttons": [
                    {"label": "1 @ KSh5", "kg_amount": 1, "price": 5, "sort_order": 0},
                    {"label": "3 @ KSh10", "kg_amount": 3, "price": 10, "sort_order": 1},
                ],
            }, headers={"Authorization": f"Bearer {token}"})
            checks.check(ok.status_code == 201, f"counted create with amounts succeeds: HTTP {ok.status_code}")
            product_id = ok.get_json()["id"]

            # Editing that product may still keep amounts (no regression).
            edit = client.put(f"/api/products/{product_id}", json={
                "price_buttons": [
                    {"label": "1 @ KSh5", "kg_amount": 1, "price": 5, "sort_order": 0},
                    {"label": "3 @ KSh10", "kg_amount": 3, "price": 10, "sort_order": 1},
                ],
            }, headers={"Authorization": f"Bearer {token}"})
            checks.check(edit.status_code == 200, f"edit with amounts succeeds: HTTP {edit.status_code}")
    _cleanup(tmpdir)
    checks.done()


def test_retry_after_lost_response_does_not_double_deduct():
    """The critical offline-safety case: the server commits a sale but the
    response is lost (phone dies in flight). The retry re-sends the same
    client_uuid; the backend must ack it as a duplicate and NOT deduct stock
    a second time."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)
        uuid = "lost-response-1"
        created = datetime.now(timezone.utc).isoformat()

        def _send():
            with app.test_client() as client:
                return client.post(
                    "/api/sales/sync",
                    json={"sales": [{
                        "client_uuid": uuid, "product_id": product.id,
                        "attendant_id": attendant.id, "quantity_sold": 3,
                        "unit_sold_in": "piece", "price_charged": 10 / 3,
                        "created_at": created, "amount_in_base_unit": 3,
                    }]},
                    headers={"Authorization": f"Bearer {token}"},
                ).get_json()["results"][0]

        r1 = _send()
        checks.check(r1["status"] == "synced", f"first attempt commits: {r1.get('status')}")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, "stock deducted once after first attempt")

        # Retry — the client never saw the first ack, so it re-sends verbatim.
        r2 = _send()
        checks.check(r2["status"] == "duplicate", f"retry acked as duplicate: {r2.get('status')}")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, "NO second deduction after retry")
        checks.check(Sale.query.filter_by(client_uuid=uuid).count() == 1, "exactly one sale row for the uuid")
    _cleanup(tmpdir)
    checks.done()


def test_tracked_counted_void_restores_exactly():
    """Voiding a tracked bundle puts its exact pieces back on the right batches."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_tomatoes()
        token = _mk_token(attendant.id)

        _sync_one(app, token, "void-bundle", product, attendant, 3, "piece", 10 / 3, amount=3)
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 97.0) < 1e-9, "97 left after sale")

        sale = Sale.query.filter_by(client_uuid="void-bundle").first()
        with app.test_client() as client:
            res = client.post(f"/api/sales/{sale.id}/void", headers={"Authorization": f"Bearer {token}"})
        checks.check(res.status_code == 200, f"void succeeds: HTTP {res.status_code}")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 100.0) < 1e-9, f"exactly 3 pieces restored -> {batch.quantity_remaining}")
        db.session.refresh(sale)
        checks.check(sale.voided_at is not None, "sale marked voided")
    _cleanup(tmpdir)
    checks.done()


if __name__ == "__main__":
    test_3_tomatoes_deducts_3_pieces()
    test_single_and_six_options()
    test_nonlinear_bundle_revenue_exact()
    test_bundle_crosses_batches()
    test_legacy_counted_null_amount_backward_compatible()
    test_rice_portions_deduct_exact_kg()
    test_brands_have_independent_stock()
    test_counted_create_requires_amounts()
    test_retry_after_lost_response_does_not_double_deduct()
    test_tracked_counted_void_restores_exactly()
