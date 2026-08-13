"""
Regression tests — Sales screen (pagination, grouping, snapshots, day filter).

Covers the /api/sales/page endpoint: pagination, transaction grouping by
sale_uuid, historical snapshots surviving product renames/price changes, and
Kenya business-day date filtering. Mirrors the isolated-DB test pattern.

Run from anywhere:
    python3 backend/tests/test_sales_page.py
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
from app.models.stock_batch import StockBatch, BatchStatus  # noqa: E402
from app.models.sale import Sale  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402


class _Checks:
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


def _mk_token(attendant_id: int) -> str:
    return create_access_token(identity=str(attendant_id), additional_claims={"role": "owner"})


def _seed_rice():
    attendant = Attendant(name="Test Owner", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
    db.session.add(attendant)
    db.session.flush()
    product = Product(
        name="Pishori Rice", category=Category.dry, base_unit=BaseUnit.kg,
        pricing_mode=PricingMode.weighed, sell_price=140.0, reorder_threshold=2.0,
    )
    db.session.add(product)
    db.session.flush()
    batch = StockBatch(
        product_id=product.id, bulk_quantity=50, bulk_unit="kg", total_cost=5000,
        cost_per_base_unit=100.0, quantity_remaining=50,
        date_received=datetime.now(timezone.utc) - timedelta(days=3), status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return attendant, product, batch


def _sync_one(app, token, uuid, product, attendant, qty, unit, price, created_at, sale_uuid=None, button_label=None):
    item = {
        "client_uuid": uuid,
        "product_id": product.id,
        "attendant_id": attendant.id,
        "quantity_sold": qty,
        "unit_sold_in": unit,
        "price_charged": price,
        "created_at": created_at,
    }
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


def _page(app, token, **params):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    with app.test_client() as client:
        res = client.get(f"/api/sales/page?{qs}", headers={"Authorization": f"Bearer {token}"})
    return res.status_code, res.get_json()


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


def test_page_pagination_and_grouping():
    """Two transactions (5 lines total) paginate by line; sale_uuid groups them."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)
        now = datetime.now(timezone.utc).isoformat()

        # Cart A: two lines. Cart B: three lines.
        _sync_one(app, token, "A-0", product, attendant, 0.25, "kg", 160, now, sale_uuid="cartA", button_label="1/4 kg")
        _sync_one(app, token, "A-1", product, attendant, 0.5, "kg", 150, now, sale_uuid="cartA", button_label="1/2 kg")
        _sync_one(app, token, "B-0", product, attendant, 1.0, "kg", 140, now, sale_uuid="cartB", button_label="1 kg")
        _sync_one(app, token, "B-1", product, attendant, 0.25, "kg", 160, now, sale_uuid="cartB", button_label="1/4 kg")
        _sync_one(app, token, "B-2", product, attendant, 0.5, "kg", 150, now, sale_uuid="cartB", button_label="1/2 kg")

        code, body = _page(app, token, page="1", per_page="2")
        checks.check(code == 200 and len(body["items"]) == 2, f"page 1 returns 2 lines ({len(body['items'])})")
        checks.check(body["total"] == 5, f"total == 5 ({body['total']})")
        checks.check(body["has_more"] is True, "has_more true on page 1")
        checks.check(all(s["sale_uuid"] for s in body["items"]), "sale_uuid present on every row")

        code2, body2 = _page(app, token, page="3", per_page="2")
        checks.check(len(body2["items"]) == 1 and body2["has_more"] is False, "page 3 returns the last line, has_more false")
    _cleanup(tmpdir)
    checks.done()


def test_snapshots_survive_rename_and_price_change():
    """History keeps the original name, button label, price, cost and profit
    even after the product is renamed and its price changed."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)

        _sync_one(
            app, token, "hist-1", product, attendant, 0.25, "kg", 40 / 0.25,
            datetime.now(timezone.utc).isoformat(), sale_uuid="cartH", button_label="1/4 kg",
        )

        # Rename + change price on the product.
        with app.test_client() as client:
            res = client.put(
                f"/api/products/{product.id}",
                json={"name": "Mwea Rice (renamed)", "sell_price": 180.0},
                headers={"Authorization": f"Bearer {token}"},
            )
        checks.check(res.status_code == 200, f"product rename succeeds: HTTP {res.status_code}")

        code, body = _page(app, token)
        sale = body["items"][0]
        checks.check(sale["product_name_snapshot"] == "Pishori Rice", f"snapshot keeps old name ({sale['product_name_snapshot']})")
        checks.check(sale["product_name"] == "Pishori Rice", "list product_name prefers the snapshot")
        checks.check(sale["button_label_snapshot"] == "1/4 kg", f"button label snapshotted ({sale['button_label_snapshot']})")
        checks.check(abs(sale["price_charged"] - 160.0) < 1e-9, f"price_charged unchanged ({sale['price_charged']})")
        checks.check(abs(sale["cost_at_sale"] - 100.0) < 1e-9 and abs(sale["profit"] - 15.0) < 1e-9, "cost/profit unchanged")
    _cleanup(tmpdir)
    checks.done()


def test_date_range_uses_kenya_business_day():
    """A sale at 00:30 EAT (21:30 UTC the previous day) belongs to the Kenya
    business day that started at 21:00 UTC."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)

        # 2026-08-11T21:30:00Z == 2026-08-12 00:30 EAT
        _sync_one(app, token, "midnight", product, attendant, 0.25, "kg", 160, "2026-08-11T21:30:00+00:00", sale_uuid="cartM")

        code, on_day = _page(app, token, from_="2026-08-12", to="2026-08-12")
        checks.check(len(on_day["items"]) == 1, f"00:30 EAT sale lands on Aug 12 ({len(on_day['items'])})")
        code2, prev_day = _page(app, token, from_="2026-08-11", to="2026-08-11")
        checks.check(len(prev_day["items"]) == 0, "same sale excluded from Aug 11")

        # The legacy list endpoint date param uses the same business day.
        with app.test_client() as client:
            res = client.get("/api/sales?date=2026-08-12", headers={"Authorization": f"Bearer {token}"})
        checks.check(len(res.get_json()) == 1, "GET /sales?date=2026-08-12 includes the 00:30 EAT sale")
    _cleanup(tmpdir)
    checks.done()


def test_csv_export():
    """GET /api/sales/export returns the filtered sales as an Excel-friendly
    CSV with the required columns, count preserved, and Kenya local times."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)

        # 2026-08-11T10:00Z == 13:00 EAT Aug 11; count 2 on the 1/4 kg button.
        _sync_one(app, token, "exp-1", product, attendant, 0.25, "kg", 40 / 0.25,
                  "2026-08-11T10:00:00+00:00", sale_uuid="cartE", button_label="1/4 kg")
        # Second line carries the count snapshot.
        with app.test_client() as client:
            client.post("/api/sales/sync", json={"sales": [{
                "client_uuid": "exp-2",
                "product_id": product.id,
                "attendant_id": attendant.id,
                "quantity_sold": 0.5,
                "unit_sold_in": "kg",
                "price_charged": 40 / 0.25,
                "created_at": "2026-08-11T10:30:00+00:00",
                "sale_uuid": "cartE",
                "button_label": "1/4 kg",
                "count": 2,
            }]}, headers={"Authorization": f"Bearer {token}"})

        with app.test_client() as client:
            res = client.get("/api/sales/export?from=2026-08-11&to=2026-08-11",
                             headers={"Authorization": f"Bearer {token}"})
        checks.check(res.status_code == 200, f"export returns 200 ({res.status_code})")
        checks.check("text/csv" in res.content_type, f"csv content type ({res.content_type})")
        checks.check("attachment" in res.headers.get("Content-Disposition", ""), "download attachment header")

        text = res.get_data(as_text=True)
        checks.check(text.startswith("\ufeff"), "UTF-8 BOM for Excel")
        header = text.splitlines()[0]
        for col in ["Date/time", "Transaction", "Product", "Selling button", "Count",
                    "Quantity/base amount", "Revenue", "Cost", "Profit", "Attendant", "Status"]:
            checks.check(col in header, f"header includes {col}")

        rows = text.splitlines()[1:]
        checks.check(len(rows) == 2, f"both filtered lines exported ({len(rows)})")
        # Newest first (created_at DESC): the count=2 line (13:30 EAT) is row 0.
        newest, older = rows[0], rows[1]
        checks.check("cartE" in newest and "cartE" in older, "transaction column groups by sale_uuid")
        checks.check("2026-08-11 13:30" in newest, f"date/time shown in Kenya local time ({newest})")
        checks.check("Pishori Rice" in newest and "1/4 kg" in newest, "product + button name present")
        checks.check("0.5 kg" in newest, "quantity/base amount present")
        checks.check("2" in newest.split(",")[4], f"count column carries the count ({newest})")
        checks.check("synced" in newest, "status column")

        # Date filtering applies: nothing on Aug 12.
        with app.test_client() as client:
            empty = client.get("/api/sales/export?from=2026-08-12&to=2026-08-12",
                               headers={"Authorization": f"Bearer {token}"}).get_data(as_text=True)
        checks.check(len(empty.splitlines()) == 1, "empty range exports only the header")
    _cleanup(tmpdir)
    checks.done()


def test_csv_export_neutralizes_formula_injection():
    """A user-controlled product name starting with '=' must be inert text in
    the CSV (single-quote prefix), never a spreadsheet formula."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)

        product.name = "=SUM(A1:A9)"
        db.session.commit()
        _sync_one(app, token, "inj-1", product, attendant, 0.25, "kg", 160,
                  datetime.now(timezone.utc).isoformat(), sale_uuid="cartI", button_label="@evil")

        with app.test_client() as client:
            res = client.get("/api/sales/export", headers={"Authorization": f"Bearer {token}"})
        text = res.get_data(as_text=True)
        checks.check("'=SUM(A1:A9)" in text, "product name neutralized with a leading quote")
        checks.check("'@evil" in text, "button label starting with @ neutralized")
    _cleanup(tmpdir)
    checks.done()


def test_daily_summary_range():
    """daily-summary aggregates a Kenya business-day range."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, batch = _seed_rice()
        token = _mk_token(attendant.id)

        # Day 1 (Kenya): 2026-08-11T10:00Z == 13:00 EAT Aug 11
        _sync_one(app, token, "d1", product, attendant, 0.25, "kg", 160, "2026-08-11T10:00:00+00:00", sale_uuid="c1")
        # Day 2 (Kenya): 2026-08-12T10:00Z == 13:00 EAT Aug 12
        _sync_one(app, token, "d2", product, attendant, 0.5, "kg", 150, "2026-08-12T10:00:00+00:00", sale_uuid="c2")

        with app.test_client() as client:
            one = client.get("/api/sales/daily-summary?date=2026-08-12", headers={"Authorization": f"Bearer {token}"}).get_json()
            both = client.get("/api/sales/daily-summary?from=2026-08-11&to=2026-08-12", headers={"Authorization": f"Bearer {token}"}).get_json()
        # Aug 12 holds only the 13:00 EAT sale (0.5 kg @ 150 → 75.00).
        checks.check(one["sale_count"] == 1 and round(one["total_revenue"], 2) == 75.0, f"single day: 1 sale, 75.00 ({one})")
        checks.check(both["sale_count"] == 2 and round(both["total_revenue"], 2) == 115.0, f"range: 2 sales, 115.00 ({both['total_revenue']})")
    _cleanup(tmpdir)
    checks.done()


if __name__ == "__main__":
    test_page_pagination_and_grouping()
    test_snapshots_survive_rename_and_price_change()
    test_date_range_uses_kenya_business_day()
    test_csv_export()
    test_csv_export_neutralizes_formula_injection()
    test_daily_summary_range()
