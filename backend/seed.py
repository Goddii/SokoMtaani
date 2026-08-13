"""
SokoMtaani seed script — inserts realistic Kenyan demo data.
Run from the backend/ directory:
    python seed.py

Idempotent: safe to re-run; existing data is cleared first.
NOT real client data — demonstration data only.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

# Make sure we can import app modules
sys.path.insert(0, os.path.dirname(__file__))

from app import create_app
from app.extensions import db, hash_pin
from app.models.attendant import Attendant, ShopRole
from app.models.product import Product, BaseUnit, Category, PricingMode
from app.models.price_button import PriceButton
from app.models.stock_batch import StockBatch, BatchStatus
from app.models.sale import Sale, SyncStatus
from app.models.wastage import Wastage, WastageReason
from app.utils.unit_conversion import to_base_unit


def days_ago(n: int, hour: int = 10, minute: int = 0) -> datetime:
    d = datetime.now(timezone.utc) - timedelta(days=n)
    return d.replace(hour=hour, minute=minute, second=0, microsecond=0)


def seed():
    app = create_app("development")
    with app.app_context():
        print("⚙️  Clearing existing data …")
        # Order matters due to FK constraints
        db.session.query(Wastage).delete()
        db.session.query(Sale).delete()
        db.session.query(StockBatch).delete()
        db.session.query(PriceButton).delete()
        db.session.query(Product).delete()
        db.session.query(Attendant).delete()
        db.session.commit()

        print("👥  Creating attendants …")
        attendants = [
            Attendant(
                name="Wanjiku Kamau",
                pin_hash=hash_pin("1240"),
                shop_role=ShopRole.owner,
                active=True,
            ),
            Attendant(
                name="Otieno Ochieng",
                pin_hash=hash_pin("3168"),
                shop_role=ShopRole.attendant,
                active=True,
            ),
            Attendant(
                name="Achieng Adhiambo",
                pin_hash=hash_pin("2057"),
                shop_role=ShopRole.attendant,
                active=True,
            ),
            Attendant(
                name="Maina Kariuki",
                pin_hash=hash_pin("4821"),
                shop_role=ShopRole.attendant,
                active=True,
            ),
        ]
        db.session.add_all(attendants)
        db.session.flush()

        wanjiku, otieno, achieng, maina = attendants
        print(f"   Owner PIN (Wanjiku): 1240")
        print(f"   Attendant PINs: Otieno=3168, Achieng=2057, Maina=4821")

        print("📦  Creating products …")
        products = {
            "onions": Product(
                name="Red Onions",
                category=Category.produce,
                base_unit=BaseUnit.kg,
                pricing_mode=PricingMode.weighed,
                avg_piece_weight=None,
                sell_price=140.0,
                reorder_threshold=20.0,
                # Exact-weight price buttons so the till doesn't need a keypad
                price_buttons=[
                    PriceButton(label="1/4 kg", kg_amount=0.25, price=35.0, sort_order=0),
                    PriceButton(label="1/2 kg", kg_amount=0.5, price=70.0, sort_order=1),
                    PriceButton(label="1 kg", kg_amount=1.0, price=140.0, sort_order=2),
                ],
            ),
            "tomatoes": Product(
                name="Tomatoes",
                category=Category.produce,
                base_unit=BaseUnit.kg,
                # Sold by piece/bunch at the till — no weighing, no per-kg cost
                pricing_mode=PricingMode.counted,
                avg_piece_weight=0.08,  # 1 tomato ≈ 80g (reference only)
                sell_price=0.0,
                reorder_threshold=20.0,
                price_buttons=[
                    PriceButton(label="1 @ KSh5", kg_amount=None, price=5.0, sort_order=0),
                    PriceButton(label="3 @ KSh20", kg_amount=None, price=20.0, sort_order=1),
                ],
            ),
            "garlic": Product(
                name="Garlic",
                category=Category.produce,
                base_unit=BaseUnit.kg,
                pricing_mode=PricingMode.counted,
                avg_piece_weight=None,
                sell_price=0.0,
                reorder_threshold=10.0,
                price_buttons=[
                    PriceButton(label="1 @ KSh5", kg_amount=None, price=5.0, sort_order=0),
                    PriceButton(label="5 @ KSh20", kg_amount=None, price=20.0, sort_order=1),
                ],
            ),
            "potatoes": Product(
                name="Potatoes",
                category=Category.produce,
                base_unit=BaseUnit.kg,
                pricing_mode=PricingMode.counted,
                avg_piece_weight=None,
                sell_price=0.0,
                reorder_threshold=15.0,
                price_buttons=[
                    PriceButton(label="1 @ KSh10", kg_amount=None, price=10.0, sort_order=0),
                    PriceButton(label="4 @ KSh35", kg_amount=None, price=35.0, sort_order=1),
                    PriceButton(label="10 @ KSh80", kg_amount=None, price=80.0, sort_order=2),
                ],
            ),
            "rice": Product(
                name="Pishori Rice",
                category=Category.dry,
                base_unit=BaseUnit.kg,
                pricing_mode=PricingMode.weighed,
                avg_piece_weight=None,
                sell_price=260.0,
                reorder_threshold=30.0,
                price_buttons=[
                    PriceButton(label="1/4 kg", kg_amount=0.25, price=65.0, sort_order=0),
                    PriceButton(label="1/2 kg", kg_amount=0.5, price=130.0, sort_order=1),
                    PriceButton(label="1 kg", kg_amount=1.0, price=260.0, sort_order=2),
                ],
            ),
            "sukuma": Product(
                name="Sukuma Wiki (bunch)",
                category=Category.produce,
                base_unit=BaseUnit.piece,
                avg_piece_weight=None,
                sell_price=30.0,
                reorder_threshold=25.0,
            ),
            "oil": Product(
                name="Cooking Oil (1L)",
                category=Category.dry,
                base_unit=BaseUnit.litre,
                avg_piece_weight=None,
                sell_price=460.0,
                reorder_threshold=12.0,
            ),
            "basin": Product(
                name="Plastic Basin (large)",
                category=Category.packaging,
                base_unit=BaseUnit.piece,
                avg_piece_weight=None,
                sell_price=450.0,
                reorder_threshold=10.0,
            ),
            "bags": Product(
                name="Carrier Bags (med)",
                category=Category.packaging,
                base_unit=BaseUnit.piece,
                avg_piece_weight=None,
                sell_price=5.0,
                reorder_threshold=200.0,
            ),
        }
        db.session.add_all(products.values())
        db.session.flush()

        print("📥  Creating stock batches …")
        # Onions: one closed batch + two open
        b_onions_old = StockBatch(
            product_id=products["onions"].id,
            bulk_quantity=50, bulk_unit="kg",
            total_cost=4500,
            cost_per_base_unit=90.0,
            quantity_remaining=0,
            date_received=days_ago(18),
            status=BatchStatus.closed,
            closed_at=days_ago(10),
        )
        b_onions_1 = StockBatch(
            product_id=products["onions"].id,
            bulk_quantity=40, bulk_unit="kg",
            total_cost=4100,
            cost_per_base_unit=102.5,
            quantity_remaining=18.0,
            date_received=days_ago(9),
            status=BatchStatus.open,
        )
        b_onions_2 = StockBatch(
            product_id=products["onions"].id,
            bulk_quantity=30, bulk_unit="kg",
            total_cost=3150,
            cost_per_base_unit=105.0,
            quantity_remaining=30.0,
            date_received=days_ago(2),
            status=BatchStatus.open,
        )

        # Tomatoes
        b_tomatoes_old = StockBatch(
            product_id=products["tomatoes"].id,
            bulk_quantity=50, bulk_unit="kg",
            total_cost=4200,
            cost_per_base_unit=84.0,
            quantity_remaining=0,
            date_received=days_ago(11),
            status=BatchStatus.closed,
            closed_at=days_ago(5),
        )
        b_tomatoes = StockBatch(
            product_id=products["tomatoes"].id,
            bulk_quantity=40, bulk_unit="kg",
            total_cost=3900,
            cost_per_base_unit=97.5,
            quantity_remaining=12.0,
            date_received=days_ago(4),
            status=BatchStatus.open,
        )

        # Garlic (counted — bulk quantity is a loose estimate, not used for cost)
        b_garlic = StockBatch(
            product_id=products["garlic"].id,
            bulk_quantity=30, bulk_unit="kg",
            total_cost=3600,
            cost_per_base_unit=120.0,
            quantity_remaining=30.0,
            date_received=days_ago(5),
            status=BatchStatus.open,
        )

        # Potatoes (counted)
        b_potatoes = StockBatch(
            product_id=products["potatoes"].id,
            bulk_quantity=50, bulk_unit="kg",
            total_cost=4000,
            cost_per_base_unit=80.0,
            quantity_remaining=50.0,
            date_received=days_ago(6),
            status=BatchStatus.open,
        )

        # Rice
        b_rice_old = StockBatch(
            product_id=products["rice"].id,
            bulk_quantity=50, bulk_unit="kg",
            total_cost=10750,
            cost_per_base_unit=215.0,
            quantity_remaining=0,
            date_received=days_ago(19),
            status=BatchStatus.closed,
            closed_at=days_ago(6),
        )
        b_rice = StockBatch(
            product_id=products["rice"].id,
            bulk_quantity=100, bulk_unit="kg",
            total_cost=21200,
            cost_per_base_unit=212.0,
            quantity_remaining=70.0,
            date_received=days_ago(5),
            status=BatchStatus.open,
        )

        # Sukuma Wiki
        b_sukuma = StockBatch(
            product_id=products["sukuma"].id,
            bulk_quantity=150, bulk_unit="piece",
            total_cost=1950,
            cost_per_base_unit=13.0,
            quantity_remaining=60.0,
            date_received=days_ago(6),
            status=BatchStatus.open,
        )

        # Cooking Oil
        b_oil_old = StockBatch(
            product_id=products["oil"].id,
            bulk_quantity=20, bulk_unit="litre",
            total_cost=7200,
            cost_per_base_unit=360.0,
            quantity_remaining=0,
            date_received=days_ago(21),
            status=BatchStatus.closed,
            closed_at=days_ago(8),
        )
        b_oil = StockBatch(
            product_id=products["oil"].id,
            bulk_quantity=40, bulk_unit="litre",
            total_cost=14200,
            cost_per_base_unit=355.0,
            quantity_remaining=26.0,
            date_received=days_ago(7),
            status=BatchStatus.open,
        )

        # Plastic Basins
        b_basin = StockBatch(
            product_id=products["basin"].id,
            bulk_quantity=24, bulk_unit="piece",
            total_cost=7680,
            cost_per_base_unit=320.0,
            quantity_remaining=9.0,
            date_received=days_ago(14),
            status=BatchStatus.open,
        )

        # Carrier Bags
        b_bags = StockBatch(
            product_id=products["bags"].id,
            bulk_quantity=500, bulk_unit="piece",
            total_cost=1150,
            cost_per_base_unit=2.3,
            quantity_remaining=640.0,
            date_received=days_ago(10),
            status=BatchStatus.open,
        )

        all_batches = [
            b_onions_old, b_onions_1, b_onions_2,
            b_tomatoes_old, b_tomatoes,
            b_garlic, b_potatoes,
            b_rice_old, b_rice,
            b_sukuma,
            b_oil_old, b_oil,
            b_basin, b_bags,
        ]
        db.session.add_all(all_batches)
        db.session.flush()

        # Update cost caches
        for product in products.values():
            product.refresh_cost_cache()
        db.session.flush()

        print("💰  Creating sales history (14 days) …")
        import uuid as uuid_mod
        import random
        rng = random.Random(20260804)

        # Define sale scenarios: (product_key, qty, unit, price, batch)
        sale_templates = [
            ("onions", 1.0, "kg", 140, b_onions_1),
            ("onions", 2.0, "kg", 140, b_onions_1),
            ("onions", 0.5, "kg", 70, b_onions_1),
            # Counted produce — quantity_sold=1, price_charged = button's fixed price
            ("tomatoes", 1, "kg", 5, b_tomatoes),
            ("tomatoes", 1, "kg", 20, b_tomatoes),
            ("garlic", 1, "kg", 5, b_garlic),
            ("garlic", 1, "kg", 20, b_garlic),
            ("potatoes", 1, "kg", 10, b_potatoes),
            ("potatoes", 1, "kg", 35, b_potatoes),
            ("potatoes", 1, "kg", 80, b_potatoes),
            ("rice", 1.0, "kg", 260, b_rice),
            ("rice", 2.0, "kg", 260, b_rice),
            ("rice", 0.5, "kg", 135, b_rice),
            ("sukuma", 2, "piece", 30, b_sukuma),
            ("sukuma", 1, "piece", 30, b_sukuma),
            ("oil", 1.0, "litre", 460, b_oil),
            ("bags", 10, "piece", 5, b_bags),
            ("bags", 5, "piece", 5, b_bags),
            ("basin", 1, "piece", 450, b_basin),
        ]

        all_attendants = [wanjiku, otieno, achieng, maina]
        sales = []
        import_counter = 0

        for day_offset in range(14, -1, -1):
            num_sales = rng.randint(5, 12)
            for _ in range(num_sales):
                tmpl = rng.choice(sale_templates)
                product_key, qty, unit_sold, price, batch = tmpl
                product = products[product_key]
                attendant = rng.choice(all_attendants)
                hour = rng.randint(8, 19)
                minute = rng.randint(0, 59)
                created = days_ago(day_offset, hour, minute)
                if created > datetime.now(timezone.utc):
                    continue  # don't seed sales in the future
                import_counter += 1

                # Counted products have no per-sale cost allocation — cost 0,
                # profit 0; the batch's P&L (revenue_so_far - total_cost) is
                # where their profit shows up.
                if product.pricing_mode == PricingMode.counted:
                    cost_at_sale = 0.0
                    profit = 0.0
                else:
                    # cost_at_sale from the batch
                    if unit_sold == "piece" and product.base_unit.value == "kg":
                        cost_at_sale = batch.cost_per_base_unit * (product.avg_piece_weight or 1)
                    else:
                        cost_at_sale = batch.cost_per_base_unit

                    profit = (price - cost_at_sale) * qty

                sale = Sale(
                    client_uuid=str(uuid_mod.uuid4()),
                    product_id=product.id,
                    batch_id=batch.id,
                    attendant_id=attendant.id,
                    quantity_sold=qty,
                    unit_sold_in=unit_sold,
                    price_charged=price,
                    cost_at_sale=cost_at_sale,
                    profit=profit,
                    sync_status=SyncStatus.synced,
                    created_at=created,
                    synced_at=created,
                )
                sales.append(sale)

        db.session.add_all(sales)
        db.session.flush()

        print("🗑️  Creating wastage log …")
        wastage_plan = [
            (products["tomatoes"], 4.0, WastageReason.spoilage, b_tomatoes, 2),
            (products["sukuma"], 8.0, WastageReason.spoilage, b_sukuma, 2),
            (products["onions"], 3.0, WastageReason.spoilage, b_onions_1, 4),
            (products["bags"], 25.0, WastageReason.damage, b_bags, 5),
            (products["tomatoes"], 2.5, WastageReason.spoilage, b_tomatoes, 7),
            (products["rice"], 2.0, WastageReason.other, b_rice, 6),
            (products["oil"], 1.0, WastageReason.damage, b_oil, 3),
            (products["basin"], 1.0, WastageReason.damage, b_basin, 1),
        ]

        for product, qty, reason, batch, d in wastage_plan:
            db.session.add(Wastage(
                product_id=product.id,
                batch_id=batch.id,
                quantity=qty,
                reason=reason,
                date=days_ago(d, 10),
                recorded_by=wanjiku.id,
            ))

        db.session.commit()
        print(f"\n✅  Seed complete!")
        print(f"   {len(attendants)} attendants")
        print(f"   {len(products)} products")
        print(f"   {len(all_batches)} stock batches")
        print(f"   {len(sales)} historical sales")
        print(f"   {len(wastage_plan)} wastage entries")
        print(f"\n🔑  Login credentials:")
        print(f"   Wanjiku Kamau  (owner)     → ID: {wanjiku.id}, PIN: 1240")
        print(f"   Otieno Ochieng (attendant) → ID: {otieno.id}, PIN: 3168")
        print(f"   Achieng Adhiambo (attendant)→ ID: {achieng.id}, PIN: 2057")
        print(f"   Maina Kariuki  (attendant) → ID: {maina.id}, PIN: 4821")


if __name__ == "__main__":
    seed()
