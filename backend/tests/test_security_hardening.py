"""
Regression tests — security hardening from the codebase review.

Covers: PIN lockout (login + verify-pin), server-side owner enforcement on the
dashboard / batches / daily-summary routes, and /sales/sync resilience (a failure
on one line must never undo lines already reported as synced).

Run from anywhere:
    python3 backend/tests/test_security_hardening.py

Plain asserts with a standalone main (same convention as the other tests here).
"""
import os
import sys
import tempfile
from datetime import datetime, timezone
from unittest import mock

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

OWNER_PIN = "1240"
ATTENDANT_PIN = "3168"


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
    return create_app(key)


def _auth(attendant: Attendant) -> dict:
    token = create_access_token(
        identity=str(attendant.id),
        additional_claims={"role": attendant.shop_role.value},
    )
    return {"Authorization": f"Bearer {token}"}


def _seed():
    """Owner + attendant + a kg product with one 10 kg batch."""
    owner = Attendant(name="Owner", pin_hash=hash_pin(OWNER_PIN), shop_role=ShopRole.owner, active=True)
    clerk = Attendant(name="Clerk", pin_hash=hash_pin(ATTENDANT_PIN), shop_role=ShopRole.attendant, active=True)
    db.session.add_all([owner, clerk])
    db.session.flush()
    product = Product(
        name="Rice", category=Category.dry, base_unit=BaseUnit.kg,
        pricing_mode=PricingMode.weighed, sell_price=200.0, reorder_threshold=1.0,
    )
    db.session.add(product)
    db.session.flush()
    batch = StockBatch(
        product_id=product.id, bulk_quantity=10.0, bulk_unit="kg", total_cost=1000.0,
        cost_per_base_unit=100.0, quantity_remaining=10.0, status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return owner, clerk, product, batch


def _line(uuid: str, product_id: int, attendant_id: int, qty: float) -> dict:
    return {
        "client_uuid": uuid,
        "product_id": product_id,
        "attendant_id": attendant_id,
        "quantity_sold": qty,
        "unit_sold_in": "kg",
        "price_charged": 200.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def test_pin_lockout():
    app, checks = _make_test_app(), _Checks()
    with app.app_context():
        db.create_all()
        owner, clerk, _, _ = _seed()
        client = app.test_client()

        # A success mid-way resets the counter.
        for _ in range(3):
            client.post("/api/auth/login", json={"attendant_id": owner.id, "pin": "0000"})
        ok = client.post("/api/auth/login", json={"attendant_id": owner.id, "pin": OWNER_PIN})
        checks.check(ok.status_code == 200, "correct PIN after 3 failures still logs in")

        # 5 consecutive failures lock the account; the correct PIN is then refused.
        codes = [
            client.post("/api/auth/login", json={"attendant_id": owner.id, "pin": "0000"}).status_code
            for _ in range(5)
        ]
        checks.check(codes == [401, 401, 401, 401, 401], f"first 5 bad PINs answer 401 (got {codes})")
        locked = client.post("/api/auth/login", json={"attendant_id": owner.id, "pin": OWNER_PIN})
        checks.check(locked.status_code == 429, f"locked account refuses even the correct PIN (got {locked.status_code})")

        # verify-pin shares the same counter, so it can't be used to bypass login.
        headers = _auth(clerk)
        for _ in range(5):
            client.post("/api/auth/verify-pin", json={"attendant_id": clerk.id, "pin": "0000"}, headers=headers)
        locked = client.post("/api/auth/verify-pin", json={"attendant_id": clerk.id, "pin": ATTENDANT_PIN}, headers=headers)
        checks.check(locked.status_code == 429, f"verify-pin locks after repeated failures (got {locked.status_code})")
    checks.done()


def test_owner_only_data():
    app, checks = _make_test_app(), _Checks()
    with app.app_context():
        db.create_all()
        owner, clerk, product, _ = _seed()
        client = app.test_client()

        # One sale by each, so own-vs-all scoping is observable.
        for att, uuid in ((owner, "o-1"), (clerk, "c-1")):
            res = client.post("/api/sales/sync", json={"sales": [_line(uuid, product.id, att.id, 1.0)]}, headers=_auth(att))
            checks.check(res.get_json()["results"][0]["status"] == "synced", f"seed sale {uuid} synced")

        a, o = _auth(clerk), _auth(owner)
        checks.check(client.get("/api/dashboard/series", headers=a).status_code == 403, "attendant blocked from /dashboard/series")
        checks.check(client.get("/api/dashboard/series", headers=o).status_code == 200, "owner allowed on /dashboard/series")
        checks.check(client.get("/api/batches", headers=a).status_code == 403, "attendant blocked from /batches (cost data)")
        checks.check(client.get("/api/batches", headers=o).status_code == 200, "owner allowed on /batches")

        summary_a = client.get("/api/dashboard/summary", headers=a)
        body_a = summary_a.get_json()
        checks.check(summary_a.status_code == 200, "attendant still gets /dashboard/summary (Topbar alerts)")
        checks.check(
            body_a["today"]["revenue"] == 0 and body_a["today"]["profit"] == 0 and body_a["per_product"] == [],
            "attendant summary has no revenue/profit/margin data",
        )
        checks.check("low_stock_products" in body_a, "attendant summary keeps low-stock alerts")
        body_o = client.get("/api/dashboard/summary", headers=o).get_json()
        checks.check(body_o["today"]["revenue"] > 0, "owner summary carries real revenue")

        ds_a = client.get("/api/sales/daily-summary", headers=a).get_json()
        ds_o = client.get("/api/sales/daily-summary", headers=o).get_json()
        checks.check(ds_a["sale_count"] == 1, f"attendant daily-summary counts only own sales (got {ds_a['sale_count']})")
        checks.check(ds_o["sale_count"] == 2, f"owner daily-summary counts all sales (got {ds_o['sale_count']})")
    checks.done()


def test_sync_failure_does_not_undo_synced_lines():
    app, checks = _make_test_app(), _Checks()
    with app.app_context():
        db.create_all()
        owner, _, product, batch = _seed()
        client = app.test_client()

        payload = {"sales": [
            _line("good-1", product.id, owner.id, 1.0),
            _line("boom-2", product.id, owner.id, 2.0),
            _line("good-3", product.id, owner.id, 3.0),
        ]}
        # Line 2's persistence step blows up; lines 1 and 3 must survive.
        with mock.patch.object(Product, "refresh_cost_cache", side_effect=[None, RuntimeError("secret-db-detail"), None]):
            res = client.post("/api/sales/sync", json=payload, headers=_auth(owner))
        results = {r["client_uuid"]: r for r in res.get_json()["results"]}

        checks.check(res.status_code == 200, "sync still answers 200 with per-line results")
        checks.check(results["good-1"]["status"] == "synced", "line before the failure reports synced")
        checks.check(results["boom-2"]["status"] == "error", "the failing line reports error")
        checks.check(results["good-3"]["status"] == "synced", "line after the failure reports synced")
        checks.check("secret-db-detail" not in str(results["boom-2"]), "internal error text is not leaked to the client")

        persisted = sorted(s.client_uuid for s in Sale.query.all())
        checks.check(persisted == ["good-1", "good-3"], f"synced lines are really persisted (got {persisted})")
        db.session.expire_all()
        remaining = db.session.get(StockBatch, batch.id).quantity_remaining
        checks.check(abs(remaining - 6.0) < 1e-9, f"stock reflects only the persisted lines: 10-1-3=6 (got {remaining})")
    checks.done()


def test_sync_payload_validation():
    app, checks = _make_test_app(), _Checks()
    with app.app_context():
        db.create_all()
        owner, _, product, _ = _seed()
        client = app.test_client()
        headers = _auth(owner)

        res = client.post("/api/sales/sync", json={"sales": ["not-an-object", 5, None]}, headers=headers)
        checks.check(res.status_code == 200, f"non-object items don't crash the endpoint (got {res.status_code})")
        statuses = [r["status"] for r in res.get_json()["results"]]
        checks.check(statuses == ["error"] * 3, f"each non-object item reports an error (got {statuses})")

        too_many = [_line(f"u-{i}", product.id, owner.id, 0.01) for i in range(501)]
        res = client.post("/api/sales/sync", json={"sales": too_many}, headers=headers)
        checks.check(res.status_code == 422, f"oversized batch is rejected (got {res.status_code})")
    checks.done()


def test_deactivated_attendant_token_is_revoked():
    app, checks = _make_test_app(), _Checks()
    with app.app_context():
        db.create_all()
        owner, clerk, _, _ = _seed()
        client = app.test_client()
        headers = _auth(clerk)

        checks.check(client.get("/api/products", headers=headers).status_code == 200, "active attendant's token works")

        clerk.active = False
        db.session.commit()
        res = client.get("/api/products", headers=headers)
        checks.check(res.status_code == 401, f"deactivated attendant's existing token is rejected (got {res.status_code})")
        checks.check(client.get("/api/products", headers=_auth(owner)).status_code == 200, "other attendants unaffected")
    checks.done()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print("ALL TESTS PASSED")
