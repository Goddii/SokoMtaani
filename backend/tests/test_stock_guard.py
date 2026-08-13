"""
Regression tests — H2: cart quantity can exceed stock.

The backend already guards overselling per-line (see _fifo_deduct in
app/routes/sales.py): a line whose quantity_sold exceeds the stock on hand is
rejected with status 'error' and reason "Insufficient stock…", nothing is
deducted, and sibling lines in the same sync payload still sync.

These tests lock that behaviour in so it can't silently regress into
negative-stock sales, whole-cart rejection, or a broken counted-product path.

Run from anywhere:
    python3 backend/tests/test_stock_guard.py

No pytest needed — plain asserts with a standalone main. Database isolation is
critical: the app factory binds its engine at init_app, so we inject a
subclassed config with a throwaway SQLite file BEFORE create_app(). A unique
config key per app means each test gets its own DB even as the file grows, and
a guard assertion verifies the engine actually points at the temp DB so this
test can never silently write into the dev/prod database again.
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

# Allow running as `python3 backend/tests/test_stock_guard.py` from the repo root.
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from config import config as _cfg, DevelopmentConfig  # noqa: E402
from app import create_app  # noqa: E402
from app.extensions import db, hash_pin  # noqa: E402
from app.models.attendant import Attendant, ShopRole  # noqa: E402
from app.models.product import Product, BaseUnit, Category, PricingMode  # noqa: E402
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
    """A Flask app wired to a fresh throwaway SQLite file.

    The engine binds at init_app, so the config subclass must be registered
    BEFORE create_app(). A unique config key per call means multiple tests in
    this process never share a DB and never clobber a real config key.
    """
    tmpdir = tempfile.mkdtemp(prefix="soko-test-")
    db_path = os.path.join(tmpdir, "test.db")

    class _TestConfig(DevelopmentConfig):
        TESTING = True
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{db_path}"

    key = f"_soko_test_{os.urandom(4).hex()}"
    _cfg[key] = _TestConfig
    app = create_app(key)
    return app, tmpdir


def _mk_token(attendant_id: int) -> str:
    return create_access_token(identity=str(attendant_id), additional_claims={"role": "owner"})


def _seed_weighed_product():
    """Attendant + weighed kg product with one open batch of 1.0 kg."""
    attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
    db.session.add(attendant)
    db.session.flush()

    product = Product(
        name="Test Rice",
        category=Category.dry,
        base_unit=BaseUnit.kg,
        pricing_mode=PricingMode.weighed,
        sell_price=200.0,
        reorder_threshold=1.0,
    )
    db.session.add(product)
    db.session.flush()

    batch = StockBatch(
        product_id=product.id,
        bulk_quantity=1.0,
        bulk_unit="kg",
        total_cost=100.0,
        cost_per_base_unit=100.0,
        quantity_remaining=1.0,
        status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return attendant, product, batch


def test_oversell_line_rejected_per_line():
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        # Isolation guard — fail loudly rather than pollute the real database.
        checks.check(
            str(db.engine.url).endswith("test.db"),
            f"test DB isolated from the dev database (engine: {db.engine.url})",
        )
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)
        now = datetime.now(timezone.utc).isoformat()

        # Line A oversells (2 kg when only 1 exists); line B is a valid 0.5 kg.
        # A comes first to prove a rejected line doesn't poison the next one.
        with app.test_client() as client:
            res = client.post(
                "/api/sales/sync",
                json={"sales": [
                    {
                        "client_uuid": "oversell-line",
                        "product_id": product.id,
                        "attendant_id": attendant.id,
                        "quantity_sold": 2.0,
                        "unit_sold_in": "kg",
                        "price_charged": 200.0,
                        "created_at": now,
                    },
                    {
                        "client_uuid": "valid-line",
                        "product_id": product.id,
                        "attendant_id": attendant.id,
                        "quantity_sold": 0.5,
                        "unit_sold_in": "kg",
                        "price_charged": 200.0,
                        "created_at": now,
                    },
                ]},
                headers={"Authorization": f"Bearer {token}"},
            )
            body = res.get_json()
            checks.check(res.status_code == 200, "sync endpoint returns 200 (per-line results, not a whole-cart 4xx)")

            results = {r["client_uuid"]: r for r in body["results"]}

            checks.check(
                results["oversell-line"]["status"] == "error"
                and "Insufficient stock" in results["oversell-line"].get("reason", ""),
                f"oversold line rejected: {results['oversell-line'].get('reason')}",
            )
            checks.check(
                results["valid-line"]["status"] == "synced",
                f"valid sibling line still syncs: {results['valid-line'].get('status')}",
            )

            # Stock: only the valid 0.5 kg was deducted — the rejected line
            # must leave quantity_remaining untouched.
            db.session.refresh(batch)
            checks.check(
                abs(batch.quantity_remaining - 0.5) < 1e-9,
                f"batch quantity_remaining 1.0 -> {batch.quantity_remaining} (only valid line deducted)",
            )

            # Only the valid line became a Sale row.
            checks.check(Sale.query.count() == 1, "exactly one Sale row created")
            checks.check(
                Sale.query.filter_by(client_uuid="oversell-line").first() is None,
                "no Sale row for the rejected oversell line",
            )

            # Idempotency still applies to the accepted line on retry.
            with app.test_client() as client2:
                res2 = client2.post(
                    "/api/sales/sync",
                    json={"sales": [
                        {
                            "client_uuid": "valid-line",
                            "product_id": product.id,
                            "attendant_id": attendant.id,
                            "quantity_sold": 0.5,
                            "unit_sold_in": "kg",
                            "price_charged": 200.0,
                            "created_at": now,
                        },
                    ]},
                    headers={"Authorization": f"Bearer {token}"},
                )
                r2 = res2.get_json()["results"][0]
                checks.check(r2["status"] == "duplicate", f"retry of accepted line dedups: {r2['status']}")
                db.session.refresh(batch)
                checks.check(
                    abs(batch.quantity_remaining - 0.5) < 1e-9,
                    "quantity_remaining unchanged by the duplicate retry",
                )

    _cleanup(tmpdir)
    checks.done()


def test_counted_products_unaffected_by_stock_guard():
    """The stock guard must never touch the counted path: a counted button
    sale syncs (qty=1 at the fixed price), deducts nothing from
    quantity_remaining, and its revenue feeds the batch-level P&L."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(
            str(db.engine.url).endswith("test.db"),
            f"test DB isolated from the dev database (engine: {db.engine.url})",
        )
        db.create_all()

        attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
        db.session.add(attendant)
        db.session.flush()

        product = Product(
            name="Test Tomatoes",
            category=Category.produce,
            base_unit=BaseUnit.piece,
            pricing_mode=PricingMode.counted,
            sell_price=5.0,
            reorder_threshold=2.0,
        )
        db.session.add(product)
        db.session.flush()

        batch = StockBatch(
            product_id=product.id,
            bulk_quantity=10.0,
            bulk_unit="crate",
            total_cost=500.0,
            cost_per_base_unit=50.0,
            quantity_remaining=10.0,
            status=BatchStatus.open,
        )
        db.session.add(batch)
        db.session.commit()

        token = _mk_token(attendant.id)
        now = datetime.now(timezone.utc).isoformat()

        with app.test_client() as client:
            res = client.post(
                "/api/sales/sync",
                json={"sales": [
                    {
                        "client_uuid": "counted-line",
                        "product_id": product.id,
                        "attendant_id": attendant.id,
                        "quantity_sold": 1.0,
                        "unit_sold_in": "piece",
                        "price_charged": 5.0,
                        "created_at": now,
                    },
                ]},
                headers={"Authorization": f"Bearer {token}"},
            )
            r = res.get_json()["results"][0]
            checks.check(r["status"] == "synced", f"counted button sale syncs: {r.get('status')}")

            db.session.refresh(batch)
            checks.check(
                abs(batch.quantity_remaining - 10.0) < 1e-9,
                f"counted batch quantity_remaining untouched (10.0 -> {batch.quantity_remaining})",
            )

            sale = Sale.query.filter_by(client_uuid="counted-line").first()
            checks.check(sale is not None, "counted sale row created")
            if sale is not None:
                checks.check(sale.cost_at_sale == 0.0 and sale.profit == 0.0, "counted sale has no per-sale cost/profit")
            checks.check(
                abs(batch.revenue_so_far - 5.0) < 1e-9,
                f"batch revenue_so_far tracks the sale (5.0 -> {batch.revenue_so_far})",
            )
            checks.check(
                abs(batch.profit_loss - (5.0 - 500.0)) < 1e-9,
                f"batch profit_loss = revenue - total_cost ({batch.profit_loss})",
            )

    _cleanup(tmpdir)
    checks.done()


def test_duplicate_uuid_with_different_payload_is_an_error():
    """A retry re-sends an identical payload, so the backend can tell it apart
    from a cross-device client_uuid collision. A same-uuid line with different
    content must be an 'error' — never a silent 'duplicate', which the client
    treats as success and would drop the sale forever."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(
            str(db.engine.url).endswith("test.db"),
            f"test DB isolated from the dev database (engine: {db.engine.url})",
        )
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)
        now = datetime.now(timezone.utc).isoformat()

        def send(uuid: str, qty: float) -> dict:
            with app.test_client() as client:
                res = client.post(
                    "/api/sales/sync",
                    json={"sales": [{
                        "client_uuid": uuid,
                        "product_id": product.id,
                        "attendant_id": attendant.id,
                        "quantity_sold": qty,
                        "unit_sold_in": "kg",
                        "price_charged": 200.0,
                        "created_at": now,
                    }]},
                    headers={"Authorization": f"Bearer {token}"},
                )
            return res.get_json()["results"][0]

        first = send("conflict-line", 0.5)
        checks.check(first["status"] == "synced", f"first send of the uuid syncs: {first.get('status')}")

        conflict = send("conflict-line", 1.0)  # same uuid, different quantity
        checks.check(
            conflict["status"] == "error" and "client_uuid" in conflict.get("reason", ""),
            f"same uuid + different payload is an error, not a silent duplicate: {conflict.get('reason')}",
        )
        db.session.refresh(batch)
        checks.check(
            abs(batch.quantity_remaining - 0.5) < 1e-9,
            f"conflict attempt deducts nothing (remaining {batch.quantity_remaining})",
        )

        retry = send("conflict-line", 0.5)  # identical payload
        checks.check(retry["status"] == "duplicate", f"identical retry still dedups: {retry.get('status')}")
        db.session.refresh(batch)
        checks.check(
            abs(batch.quantity_remaining - 0.5) < 1e-9,
            "duplicate retry deducts nothing (quantity_remaining unchanged)",
        )
        checks.check(Sale.query.count() == 1, "the conflict never created a second Sale row")

    _cleanup(tmpdir)
    checks.done()


def _seed_two_batches(product, qty_a, cost_a, qty_b, cost_b, now):
    """Two open batches for a product; A is older so FIFO draws from it first."""
    a = StockBatch(
        product_id=product.id,
        bulk_quantity=qty_a,
        bulk_unit="kg",
        total_cost=qty_a * cost_a,
        cost_per_base_unit=cost_a,
        quantity_remaining=qty_a,
        date_received=now - timedelta(days=1),
        status=BatchStatus.open,
    )
    b = StockBatch(
        product_id=product.id,
        bulk_quantity=qty_b,
        bulk_unit="kg",
        total_cost=qty_b * cost_b,
        cost_per_base_unit=cost_b,
        quantity_remaining=qty_b,
        date_received=now,
        status=BatchStatus.open,
    )
    db.session.add_all([a, b])
    db.session.commit()
    return a, b


def _sync_one(app, token, uuid, product, attendant, qty, unit="kg") -> dict:
    with app.test_client() as client:
        res = client.post(
            "/api/sales/sync",
            json={"sales": [{
                "client_uuid": uuid,
                "product_id": product.id,
                "attendant_id": attendant.id,
                "quantity_sold": qty,
                "unit_sold_in": unit,
                "price_charged": 200.0,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }]},
            headers={"Authorization": f"Bearer {token}"},
        )
    return res.get_json()["results"][0]


def _void(app, token, sale_id: int) -> int:
    with app.test_client() as client:
        res = client.post(f"/api/sales/{sale_id}/void", headers={"Authorization": f"Bearer {token}"})
    return res.status_code


def test_void_restores_each_batch_exactly():
    """A sale can span several batches (FIFO). Voiding must put each unit back
    on the batch that actually supplied it — not dump the whole quantity on the
    first batch, which would silently skew future FIFO cost/margin."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    now = datetime.now(timezone.utc)

    with app.app_context():
        checks.check(
            str(db.engine.url).endswith("test.db"),
            f"test DB isolated from the dev database (engine: {db.engine.url})",
        )
        db.create_all()

        attendant, product, _ = _seed_weighed_product()
        token = _mk_token(attendant.id)
        # FIFO order: A (2 kg @100) older, B (2 kg @120) newer.
        a, b = _seed_two_batches(product, 2.0, 100.0, 2.0, 120.0, now)

        r = _sync_one(app, token, "multi-batch-sale", product, attendant, 3.0)
        checks.check(r["status"] == "synced", f"3 kg sale spanning two batches syncs: {r.get('status')}")

        db.session.refresh(a)
        db.session.refresh(b)
        checks.check(abs(a.quantity_remaining - 0.0) < 1e-9, f"batch A drained 2.0 -> {a.quantity_remaining} (auto-closed)")
        checks.check(abs(b.quantity_remaining - 1.0) < 1e-9, f"batch B supplied 1 of the 3 kg -> {b.quantity_remaining}")
        checks.check(a.status == BatchStatus.closed, "batch A auto-closed when emptied")

        sale = Sale.query.filter_by(client_uuid="multi-batch-sale").first()
        checks.check(
            sale.batch_allocations == [{"batch_id": a.id, "qty": 2.0}, {"batch_id": b.id, "qty": 1.0}],
            f"exact allocation recorded: {sale.batch_allocations}",
        )

        code = _void(app, token, sale.id)
        checks.check(code == 200, f"void succeeds: HTTP {code}")

        db.session.refresh(a)
        db.session.refresh(b)
        checks.check(abs(a.quantity_remaining - 2.0) < 1e-9, f"batch A gets its exact 2.0 back -> {a.quantity_remaining}")
        checks.check(abs(b.quantity_remaining - 2.0) < 1e-9, f"batch B gets its exact 1.0 back -> {b.quantity_remaining}")
        checks.check(a.status == BatchStatus.open, "batch A reopened so its stock is sellable again")
        checks.check(sale.voided_at is not None, "sale marked voided")

    _cleanup(tmpdir)
    checks.done()


def test_void_legacy_sale_falls_back_to_recorded_batch():
    """Sales recorded before batch_allocations existed keep the old behaviour:
    the whole quantity restores to the recorded batch, nothing else changes."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)

        r = _sync_one(app, token, "legacy-sale", product, attendant, 0.5)
        checks.check(r["status"] == "synced", f"legacy-style sale syncs: {r.get('status')}")

        sale = Sale.query.filter_by(client_uuid="legacy-sale").first()
        sale.batch_allocations = None  # simulate a row recorded pre-migration
        db.session.commit()

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 0.5) < 1e-9, f"batch at 0.5 before void ({batch.quantity_remaining})")

        code = _void(app, token, sale.id)
        checks.check(code == 200, f"legacy void succeeds: HTTP {code}")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 1.0) < 1e-9, f"legacy void restores full qty to recorded batch -> {batch.quantity_remaining}")

    _cleanup(tmpdir)
    checks.done()


def test_counted_void_restores_nothing():
    """Counted products never deduct stock, so voiding must not touch
    quantity_remaining — the sale's revenue just leaves the batch P&L."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
        db.session.add(attendant)
        db.session.flush()
        product = Product(
            name="Test Tomatoes",
            category=Category.produce,
            base_unit=BaseUnit.piece,
            pricing_mode=PricingMode.counted,
            sell_price=5.0,
            reorder_threshold=2.0,
        )
        db.session.add(product)
        db.session.flush()
        batch = StockBatch(
            product_id=product.id,
            bulk_quantity=10.0,
            bulk_unit="crate",
            total_cost=500.0,
            cost_per_base_unit=50.0,
            quantity_remaining=10.0,
            status=BatchStatus.open,
        )
        db.session.add(batch)
        db.session.commit()
        token = _mk_token(attendant.id)

        r = _sync_one(app, token, "counted-void-sale", product, attendant, 1.0, unit="piece")
        checks.check(r["status"] == "synced", f"counted sale syncs: {r.get('status')}")

        sale = Sale.query.filter_by(client_uuid="counted-void-sale").first()
        code = _void(app, token, sale.id)
        checks.check(code == 200, f"counted void succeeds: HTTP {code}")

        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 10.0) < 1e-9, f"counted void restores nothing -> {batch.quantity_remaining}")
        checks.check(sale.voided_at is not None, "counted sale marked voided")
        checks.check(abs(batch.revenue_so_far - 0.0) < 1e-9, "voided revenue leaves the batch P&L")

    _cleanup(tmpdir)
    checks.done()


def _put_product(app, token, product_id: int, body: dict):
    with app.test_client() as client:
        res = client.put(
            f"/api/products/{product_id}",
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
    return res.status_code, res.get_json()


def _seed_counted_product_with_open_batch():
    attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
    db.session.add(attendant)
    db.session.flush()
    product = Product(
        name="Test Tomatoes",
        category=Category.produce,
        base_unit=BaseUnit.piece,
        pricing_mode=PricingMode.counted,
        sell_price=0.0,
        reorder_threshold=2.0,
    )
    db.session.add(product)
    db.session.flush()
    batch = StockBatch(
        product_id=product.id,
        bulk_quantity=10.0,
        bulk_unit="crate",
        total_cost=500.0,
        cost_per_base_unit=50.0,
        quantity_remaining=10.0,
        status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return attendant, product


def test_mode_switch_blocked_while_open_batches_exist():
    """Switching the accounting model of a product with open stock is unsafe —
    a counted crate's size is an estimate, so FIFO would deduct exact kg
    against fiction, and weighed stock would silently become 'estimates'.
    The switch must be rejected until the open batches are closed."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        # Direction 1: counted -> weighed while an open crate exists.
        attendant, counted_prod = _seed_counted_product_with_open_batch()
        token = _mk_token(attendant.id)
        code, body = _put_product(app, token, counted_prod.id, {"pricing_mode": "weighed"})
        checks.check(code == 422, f"counted->weighed with open crate rejected: HTTP {code}")
        checks.check(
            "Close all open batches" in (body.get("errors", {}).get("pricing_mode", "")),
            f"reason tells the owner to close batches: {body.get('errors', {}).get('pricing_mode', '')}",
        )
        db.session.refresh(counted_prod)
        checks.check(counted_prod.pricing_mode == PricingMode.counted, "mode unchanged after rejected switch")

        # Direction 2: weighed -> counted while open batches exist.
        _, weighed_prod, _ = _seed_weighed_product()
        code2, _ = _put_product(app, token, weighed_prod.id, {"pricing_mode": "counted"})
        checks.check(code2 == 422, f"weighed->counted with open stock rejected: HTTP {code2}")
        db.session.refresh(weighed_prod)
        checks.check(weighed_prod.pricing_mode == PricingMode.weighed, "weighed mode unchanged after rejected switch")

    _cleanup(tmpdir)
    checks.done()


def test_mode_switch_allowed_once_batches_closed():
    """Once no open batches remain, the mode switch is legal — and switching
    to 'counted' still requires at least one price button (raw-API guard)."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)

        # Close the open batch, then switch weighed -> counted with buttons.
        batch.status = BatchStatus.closed
        batch.closed_at = datetime.now(timezone.utc)
        db.session.commit()

        code, body = _put_product(app, token, product.id, {
            "pricing_mode": "counted",
            "price_buttons": [{"label": "1 @ KSh5", "kg_amount": None, "price": 5, "sort_order": 0}],
        })
        checks.check(code == 200, f"switch to counted with no open batches succeeds: HTTP {code}")
        db.session.refresh(product)
        checks.check(product.pricing_mode == PricingMode.counted, "mode is now counted")

        # A counted product with buttons editing without a mode change must not
        # be rejected by the needs-button check.
        code_plain, _ = _put_product(app, token, product.id, {"name": "Test Rice"})
        checks.check(code_plain == 200, f"plain counted edit with buttons still succeeds: HTTP {code_plain}")

        # And back: counted -> weighed with a proper kg_amount button.
        code2, _ = _put_product(app, token, product.id, {
            "pricing_mode": "weighed",
            "price_buttons": [{"label": "1/4 kg", "kg_amount": 0.25, "price": 65, "sort_order": 0}],
        })
        checks.check(code2 == 200, f"switch back to weighed succeeds: HTTP {code2}")
        db.session.refresh(product)
        checks.check(product.pricing_mode == PricingMode.weighed, "mode is now weighed")

        # A product with no open batches at all still can't become counted
        # without a price button (raw-API bypass of the form).
        fresh = Product(
            name="Test Fresh Rice",
            category=Category.dry,
            base_unit=BaseUnit.kg,
            pricing_mode=PricingMode.weighed,
            sell_price=200.0,
            reorder_threshold=1.0,
        )
        db.session.add(fresh)
        db.session.commit()
        code3, body3 = _put_product(app, token, fresh.id, {"pricing_mode": "counted"})
        checks.check(code3 == 422, f"counted switch without buttons rejected: HTTP {code3}")
        checks.check(
            "at least one price button" in body3.get("errors", {}).get("price_buttons", ""),
            f"reason names the missing button: {body3.get('errors', {}).get('price_buttons', '')}",
        )

    _cleanup(tmpdir)
    checks.done()


def test_base_unit_switch_blocked_while_open_batches_exist():
    """Changing the base unit reinterprets every open batch's quantity in the
    new unit (kg -> piece would silently re-scale what's on the shelf). The
    switch must be rejected while open batches exist — the owner closes them
    first, and new batches then arrive in the new unit."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant, product, _ = _seed_weighed_product()
        token = _mk_token(attendant.id)

        code, body = _put_product(app, token, product.id, {"base_unit": "piece"})
        checks.check(code == 422, f"base_unit switch with open stock rejected: HTTP {code}")
        checks.check(
            "Close all open batches" in (body.get("errors", {}).get("base_unit", "")),
            f"reason tells the owner to close batches: {body.get('errors', {}).get('base_unit', '')}",
        )
        db.session.refresh(product)
        checks.check(product.base_unit == BaseUnit.kg, "base_unit unchanged after rejected switch")

        # A partial update that touches base_unit AND something else must leave
        # the other field untouched too (guard fires before any mutation).
        code2, _ = _put_product(app, token, product.id, {"base_unit": "litre", "name": "Renamed"})
        checks.check(code2 == 422, f"base_unit switch still rejected alongside a rename: HTTP {code2}")
        db.session.refresh(product)
        checks.check(product.base_unit == BaseUnit.kg, "base_unit still unchanged")
        checks.check(product.name == "Test Rice", "rename not applied — guard fires before mutation")

        # Same guard applies to counted products: an open crate is sized in
        # 'piece', so a switch to kg would reinterpret the estimate.
        _, counted_prod = _seed_counted_product_with_open_batch()
        code3, _ = _put_product(app, token, counted_prod.id, {"base_unit": "kg"})
        checks.check(code3 == 422, f"counted base_unit switch with open crate rejected: HTTP {code3}")
        db.session.refresh(counted_prod)
        checks.check(counted_prod.base_unit == BaseUnit.piece, "counted base_unit unchanged")

    _cleanup(tmpdir)
    checks.done()


def test_base_unit_switch_allowed_once_batches_closed():
    """With no open batches, a base_unit change is legal."""
    app, tmpdir = _make_test_app()
    checks = _Checks()

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)

        batch.status = BatchStatus.closed
        batch.closed_at = datetime.now(timezone.utc)
        db.session.commit()

        code, _ = _put_product(app, token, product.id, {"base_unit": "piece"})
        checks.check(code == 200, f"base_unit switch with no open batches succeeds: HTTP {code}")
        db.session.refresh(product)
        checks.check(product.base_unit == BaseUnit.piece, "base_unit is now piece")

    _cleanup(tmpdir)
    checks.done()


def test_odd_sized_button_sales_keep_exact_money():
    """Non-terminating per-unit rates must not lose money.

    A "3 @ KSh20" button sells 0.75 kg at 20/0.75 = 26.666…/kg. The customer
    pays exactly KSh 20. price_charged is stored at full float precision (never
    rounded mid-chain) so revenue and profit land within float noise of the
    exact shillings and round to exactly 20.00 / the right profit at display.
    These assertions pin that invariant — they fail if a future change stores
    price_charged at 2dp (26.67 * 0.75 = 20.0025 != 20.00) or rounds mid-chain.
    """
    app, tmpdir = _make_test_app()
    checks = _Checks()
    now = datetime.now(timezone.utc).isoformat()

    def sync(uuid: str, qty: float, price_charged: float, unit: str = "kg", product_id: int | None = None):
        with app.test_client() as client:
            res = client.post(
                "/api/sales/sync",
                json={"sales": [{
                    "client_uuid": uuid,
                    "product_id": product_id or product.id,
                    "attendant_id": attendant.id,
                    "quantity_sold": qty,
                    "unit_sold_in": unit,
                    "price_charged": price_charged,
                    "created_at": now,
                }]},
                headers={"Authorization": f"Bearer {token}"},
            )
        return res.get_json()["results"][0]

    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated from the dev database")
        db.create_all()

        attendant, product, batch = _seed_weighed_product()
        token = _mk_token(attendant.id)
        # 5 kg on hand at KSh 20/kg — clean arithmetic for the expectations.
        batch.quantity_remaining = 5.0
        batch.total_cost = 100.0
        batch.cost_per_base_unit = 20.0
        db.session.commit()

        # Case 1: 0.75 kg at 20/0.75 = 26.666…/kg (non-terminating rate).
        r = sync("odd-rate-1", 0.75, 20 / 0.75)
        checks.check(r["status"] == "synced", f"0.75 kg button sale syncs: {r.get('status')}")
        sale = Sale.query.filter_by(client_uuid="odd-rate-1").first()
        checks.check(abs(sale.revenue - 20.0) < 1e-6, f"revenue == KSh 20.00 ({sale.revenue!r})")
        checks.check(round(sale.revenue, 2) == 20.0, "display revenue rounds to exactly 20.00")
        checks.check(
            abs(sale.profit - ((20 / 0.75 - 20.0) * 0.75)) < 1e-6,
            f"profit == 5.00 ({sale.profit!r})",
        )
        checks.check(round(sale.profit, 2) == 5.0, "display profit rounds to exactly 5.00")

        # Case 2: odd decimal amount 0.333 kg at KSh10 -> 30.03…/kg.
        r2 = sync("odd-rate-2", 0.333, 10 / 0.333)
        checks.check(r2["status"] == "synced", f"0.333 kg button sale syncs: {r2.get('status')}")
        sale2 = Sale.query.filter_by(client_uuid="odd-rate-2").first()
        checks.check(abs(sale2.revenue - 10.0) < 1e-6, f"revenue == KSh 10.00 ({sale2.revenue!r})")
        checks.check(round(sale2.revenue, 2) == 10.0, "display revenue rounds to exactly 10.00")
        # Profit: 10 - (cost 20/kg x 0.333 kg) = 3.34 exactly.
        checks.check(abs(sale2.profit - (10.0 - 20.0 * 0.333)) < 1e-6, f"profit == 3.34 ({sale2.profit!r})")

        # Case 3: piece -> kg conversion with a non-clean avg_piece_weight.
        piece_prod = Product(
            name="Test Loose Peppers",
            category=Category.produce,
            base_unit=BaseUnit.kg,
            pricing_mode=PricingMode.weighed,
            avg_piece_weight=0.145,
            sell_price=2.0,
            reorder_threshold=1.0,
        )
        db.session.add(piece_prod)
        db.session.flush()
        db.session.add(StockBatch(
            product_id=piece_prod.id,
            bulk_quantity=5.0,
            bulk_unit="kg",
            total_cost=100.0,
            cost_per_base_unit=20.0,
            quantity_remaining=5.0,
            status=BatchStatus.open,
        ))
        db.session.commit()
        r3 = sync("conv-rate-1", 3, 2.0, unit="piece", product_id=piece_prod.id)
        checks.check(r3["status"] == "synced", f"piece->kg conversion sale syncs: {r3.get('status')}")
        sale3 = Sale.query.filter_by(client_uuid="conv-rate-1").first()
        # 3 pieces x 0.145 kg = 0.435 kg deducted; profit = (2 - 20*0.145) * 3.
        checks.check(
            abs(sale3.profit - ((2.0 - 20.0 * 0.145) * 3)) < 1e-6,
            f"converted sale profit exact ({sale3.profit!r})",
        )
        checks.check(round(sale3.profit, 2) == round((2.0 - 20.0 * 0.145) * 3, 2), "display profit exact at cents")

        # Stock stayed exact: the rice batch saw cases 1+2 (5 - 0.75 - 0.333),
        # the peppers batch saw case 3 (5 - 0.435).
        db.session.refresh(batch)
        checks.check(
            abs(batch.quantity_remaining - (5.0 - 0.75 - 0.333)) < 1e-9,
            f"rice batch remaining exact ({batch.quantity_remaining!r})",
        )
        peppers_batch = piece_prod.batches.first()
        db.session.refresh(peppers_batch)
        checks.check(
            abs(peppers_batch.quantity_remaining - (5.0 - 0.435)) < 1e-9,
            f"peppers batch remaining exact ({peppers_batch.quantity_remaining!r})",
        )

        # Aggregate: today's revenue rounds to exactly 36.00 (20 + 10 + 6).
        with app.test_client() as client:
            agg = client.get("/api/sales/daily-summary", headers={"Authorization": f"Bearer {token}"}).get_json()
        checks.check(agg["total_revenue"] == 36.0, f"daily revenue rounds to exactly 36.00 ({agg['total_revenue']!r})")

    _cleanup(tmpdir)
    checks.done()


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


if __name__ == "__main__":
    test_oversell_line_rejected_per_line()
    test_counted_products_unaffected_by_stock_guard()
    test_duplicate_uuid_with_different_payload_is_an_error()
    test_void_restores_each_batch_exactly()
    test_void_legacy_sale_falls_back_to_recorded_batch()
    test_counted_void_restores_nothing()
    test_mode_switch_blocked_while_open_batches_exist()
    test_mode_switch_allowed_once_batches_closed()
    test_base_unit_switch_blocked_while_open_batches_exist()
    test_base_unit_switch_allowed_once_batches_closed()
    test_odd_sized_button_sales_keep_exact_money()
