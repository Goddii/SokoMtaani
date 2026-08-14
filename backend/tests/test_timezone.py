"""
Regression tests — Kenya business time + dashboard aggregation.

- Business-day boundaries are Africa/Nairobi (a local day spans two UTC dates).
- /api/dashboard/series aggregates per Kenya business day, zero-filled,
  excluding voided sales.
- Production refuses to start without real secrets.

Run from anywhere:
    python3 backend/tests/test_timezone.py
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
from app.utils.timezone import business_day_bounds, shop_date_of, shop_now, today_shop_date  # noqa: E402
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


def _sync_one(app, token, uuid, product, attendant, created_at, qty=0.25):
    with app.test_client() as client:
        res = client.post(
            "/api/sales/sync",
            json={"sales": [{
                "client_uuid": uuid,
                "product_id": product.id,
                "attendant_id": attendant.id,
                "quantity_sold": qty,
                "unit_sold_in": "kg",
                "price_charged": 160.0,
                "created_at": created_at,
            }]},
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


def test_business_day_bounds():
    """A Kenya business day starts at 21:00 UTC the previous calendar day."""
    start, end = business_day_bounds("2026-08-12")
    checks = _Checks()
    checks.check(
        start == datetime(2026, 8, 11, 21, 0, tzinfo=timezone.utc),
        f"start == 2026-08-11 21:00 UTC ({start})",
    )
    checks.check(
        end == datetime(2026, 8, 12, 21, 0, tzinfo=timezone.utc),
        f"end == 2026-08-12 21:00 UTC ({end})",
    )
    checks.done()


def test_shop_date_of():
    checks = _Checks()
    checks.check(shop_date_of(datetime(2026, 8, 11, 21, 30, tzinfo=timezone.utc)) == "2026-08-12", "21:30 UTC == 2026-08-12 EAT")
    checks.check(shop_date_of(datetime(2026, 8, 12, 10, 0, tzinfo=timezone.utc)) == "2026-08-12", "10:00 UTC == 2026-08-12 EAT")
    checks.check(shop_date_of(datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)) == "2026-08-12", "20:59 UTC still 2026-08-12 EAT")
    checks.done()


def test_daily_summary_uses_kenya_day():
    """A sale at 00:30 EAT (21:30 UTC previous day) counts on the Kenya day."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, _ = _seed_rice()
        token = _mk_token(attendant.id)
        _sync_one(app, token, "midnight", product, attendant, "2026-08-11T21:30:00+00:00")

        with app.test_client() as client:
            aug12 = client.get("/api/sales/daily-summary?date=2026-08-12", headers={"Authorization": f"Bearer {token}"}).get_json()
            aug11 = client.get("/api/sales/daily-summary?date=2026-08-11", headers={"Authorization": f"Bearer {token}"}).get_json()
        checks.check(aug12["sale_count"] == 1, "00:30 EAT sale on the Aug 12 summary")
        checks.check(aug11["sale_count"] == 0, "not on the Aug 11 summary")
    _cleanup(tmpdir)
    checks.done()


def test_dashboard_series_groups_by_kenya_day_and_excludes_voided():
    """Series buckets are Kenya business days, zero-filled, voided excluded."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        attendant, product, _ = _seed_rice()
        token = _mk_token(attendant.id)

        # Sale timestamps are relative to today so the test never goes stale:
        # 21:30Z on the previous Kenya day == 00:30 EAT today;
        # 10:00Z today == 13:00 EAT today. days=3 always covers both.
        day2 = today_shop_date()
        day1 = (shop_now().date() - timedelta(days=1)).strftime("%Y-%m-%d")
        _sync_one(app, token, "late", product, attendant, f"{day1}T21:30:00+00:00")
        _sync_one(app, token, "afternoon", product, attendant, f"{day2}T10:00:00+00:00")

        with app.test_client() as client:
            body = client.get("/api/dashboard/series?days=3", headers={"Authorization": f"Bearer {token}"}).get_json()
        series = body["series"]
        checks.check(len(series) == 3, f"3 zero-filled buckets ({len(series)})")
        today_p = next(p for p in series if p["date"] == day2)
        checks.check(today_p["sale_count"] == 2, f"both EAT today sales grouped ({today_p})")
        checks.check(round(today_p["revenue"], 2) == 80.0, f"revenue 2 x 40.00 ({today_p['revenue']})")
        prev_p = next(p for p in series if p["date"] == day1)
        checks.check(prev_p["sale_count"] == 0, f"{day1} empty")

        # Void one sale; the series must drop it.
        sale_id = None
        with app.test_client() as client:
            rows = client.get(f"/api/sales?date={day2}", headers={"Authorization": f"Bearer {token}"}).get_json()
            sale_id = rows[0]["id"]
            client.post(f"/api/sales/{sale_id}/void", headers={"Authorization": f"Bearer {token}"})
            body2 = client.get("/api/dashboard/series?days=3", headers={"Authorization": f"Bearer {token}"}).get_json()
        today2b = next(p for p in body2["series"] if p["date"] == day2)
        checks.check(today2b["sale_count"] == 1, f"voided sale excluded from series ({today2b['sale_count']})")
    _cleanup(tmpdir)
    checks.done()


def test_production_refuses_public_secrets():
    """Production must fail fast when SECRET_KEY / JWT_SECRET_KEY are unset."""
    checks = _Checks()
    saved = {k: os.environ.get(k) for k in ("SECRET_KEY", "JWT_SECRET_KEY", "DATABASE_URL")}
    try:
        for k in ("SECRET_KEY", "JWT_SECRET_KEY"):
            os.environ.pop(k, None)
        os.environ["DATABASE_URL"] = "sqlite:////tmp/soko-prod-test.db"
        try:
            create_app("production")
            checks.check(False, "production started without secrets — should have raised")
        except RuntimeError:
            checks.check(True, "production raises RuntimeError without secrets")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    checks.done()


if __name__ == "__main__":
    test_business_day_bounds()
    test_shop_date_of()
    test_daily_summary_uses_kenya_day()
    test_dashboard_series_groups_by_kenya_day_and_excludes_voided()
    test_production_refuses_public_secrets()
