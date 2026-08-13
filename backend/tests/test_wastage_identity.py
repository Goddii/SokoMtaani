"""
Regression tests — wastage identity is server-derived.

POST /api/wastage must attribute the entry to the JWT identity, never to a
client-supplied recorded_by. Mirrors the isolated-DB test pattern.

Run from anywhere:
    python3 backend/tests/test_wastage_identity.py
"""
import os
import sys
import tempfile
from datetime import datetime, timezone

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from config import config as _cfg, DevelopmentConfig  # noqa: E402
from app import create_app  # noqa: E402
from app.extensions import db, hash_pin  # noqa: E402
from app.models.attendant import Attendant, ShopRole  # noqa: E402
from app.models.product import Product, BaseUnit, Category, PricingMode  # noqa: E402
from app.models.stock_batch import StockBatch, BatchStatus  # noqa: E402
from app.models.wastage import Wastage  # noqa: E402
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


def _mk_token(attendant_id: int, role: str) -> str:
    return create_access_token(identity=str(attendant_id), additional_claims={"role": role})


def _seed():
    owner = Attendant(name="Wanjiku", pin_hash=hash_pin("1240"), shop_role=ShopRole.owner, active=True)
    staff = Attendant(name="Otieno", pin_hash=hash_pin("3168"), shop_role=ShopRole.attendant, active=True)
    db.session.add_all([owner, staff])
    db.session.flush()
    product = Product(
        name="Red Onions", category=Category.produce, base_unit=BaseUnit.kg,
        pricing_mode=PricingMode.weighed, sell_price=140.0, reorder_threshold=5.0,
    )
    db.session.add(product)
    db.session.flush()
    batch = StockBatch(
        product_id=product.id, bulk_quantity=20, bulk_unit="kg", total_cost=2000,
        cost_per_base_unit=100.0, quantity_remaining=20,
        date_received=datetime.now(timezone.utc), status=BatchStatus.open,
    )
    db.session.add(batch)
    db.session.commit()
    return owner, staff, product, batch


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


def test_wastage_recorded_by_comes_from_jwt():
    """recorded_by in the payload is ignored entirely — the JWT identity wins."""
    app, tmpdir = _make_test_app()
    checks = _Checks()
    with app.app_context():
        checks.check(str(db.engine.url).endswith("test.db"), "test DB isolated")
        db.create_all()
        owner, staff, product, batch = _seed()

        # An attendant attempts to attribute the loss to the owner (id 999):
        # the entry must be recorded under the attendant's own identity.
        token = _mk_token(staff.id, "attendant")
        with app.test_client() as client:
            res = client.post(
                "/api/wastage",
                json={
                    "product_id": product.id,
                    "quantity": 2.0,
                    "reason": "spoilage",
                    "recorded_by": 999,  # forged — must be ignored
                },
                headers={"Authorization": f"Bearer {token}"},
            )
        checks.check(res.status_code == 201, f"wastage accepted: HTTP {res.status_code}")
        entry = Wastage.query.first()
        checks.check(entry.recorded_by == staff.id, f"recorded_by == attendant JWT identity ({entry.recorded_by})")
        db.session.refresh(batch)
        checks.check(abs(batch.quantity_remaining - 18.0) < 1e-9, "stock deducted by FIFO")

        # Owner records one; attributed to the owner.
        token_owner = _mk_token(owner.id, "owner")
        with app.test_client() as client:
            res2 = client.post(
                "/api/wastage",
                json={"product_id": product.id, "quantity": 1.0, "reason": "damage", "recorded_by": staff.id},
                headers={"Authorization": f"Bearer {token_owner}"},
            )
        checks.check(res2.status_code == 201, "owner wastage accepted")
        entry2 = Wastage.query.order_by(Wastage.id.desc()).first()
        checks.check(entry2.recorded_by == owner.id, f"recorded_by == owner JWT identity ({entry2.recorded_by})")
    _cleanup(tmpdir)
    checks.done()


if __name__ == "__main__":
    test_wastage_recorded_by_comes_from_jwt()
