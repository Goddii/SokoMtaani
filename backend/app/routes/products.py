from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from marshmallow import ValidationError

from app.extensions import db
from app.models.product import Product, PricingMode
from app.models.price_button import PriceButton
from app.models.stock_batch import StockBatch, BatchStatus
from app.schemas.product_schema import ProductSchema

products_bp = Blueprint("products", __name__)
product_schema = ProductSchema()
products_schema = ProductSchema(many=True)


def _require_owner():
    claims = get_jwt()
    if claims.get("role") != "owner":
        return jsonify({"error": "Owner access required."}), 403
    return None


def _build_buttons(raw_buttons, pricing_mode):
    """
    Turn a validated price_buttons payload into PriceButton instances.

    pricing_mode decides the kg_amount semantics:
    - 'weighed': every button needs an exact kg_amount (that's what makes the
      FIFO cost/profit math exact at the till).
    - 'counted': buttons are bare fixed prices — kg_amount is forced to None.
    """
    counted = pricing_mode == PricingMode.counted
    buttons = []
    for i, btn in enumerate(raw_buttons):
        kg_amount = btn.get("kg_amount")
        # 'counted' buttons may now carry an amount (pieces consumed from
        # stock) — NULL means a legacy untracked estimate option. 'weighed'
        # buttons always need an exact base-unit amount.
        if not counted and kg_amount is None:
            raise ValueError(
                "Each price button for a weighed product needs an amount "
                "(the exact amount it represents)."
            )
        buttons.append(
            PriceButton(
                label=btn["label"],
                kg_amount=kg_amount,
                price=btn["price"],
                sort_order=btn.get("sort_order", i),
            )
        )
    return buttons


@products_bp.get("")
@jwt_required()
def list_products():
    """GET /api/products — list all products with stock level and low-stock flag."""
    products = Product.query.order_by(Product.name).all()
    return jsonify(products_schema.dump(products)), 200


@products_bp.post("")
@jwt_required()
def create_product():
    """POST /api/products — create a new product (owner only)."""
    err = _require_owner()
    if err:
        return err

    try:
        data = product_schema.load(request.get_json(silent=True) or {})
    except ValidationError as e:
        return jsonify({"errors": e.messages}), 422

    product = Product(
        name=data["name"],
        category=data["category"],
        base_unit=data["base_unit"],
        pricing_mode=data.get("pricing_mode", PricingMode.weighed),
        avg_piece_weight=data.get("avg_piece_weight"),
        sell_price=data.get("sell_price", 0.0),
        reorder_threshold=data.get("reorder_threshold", 10.0),
    )
    buttons = data.get("price_buttons")
    if buttons:
        try:
            product.price_buttons = _build_buttons(buttons, product.pricing_mode)
        except ValueError as e:
            return jsonify({"errors": {"price_buttons": str(e)}}), 422
    elif product.pricing_mode == PricingMode.counted:
        # Sold-by-piece products are priced at the till from their buttons.
        return jsonify({"errors": {"price_buttons": "Sold-by-piece products need at least one price button."}}), 422

    # New counted products must be fully tracked: every selling option carries
    # the amount it consumes from stock. (Legacy rows with NULL amounts remain
    # readable and editable — see update_product.)
    if product.pricing_mode == PricingMode.counted and product.price_buttons:
        if any(b.kg_amount is None for b in product.price_buttons):
            return jsonify({
                "errors": {"price_buttons": "Each selling option needs an amount — how many pieces it takes from stock."}
            }), 422
    db.session.add(product)
    db.session.commit()
    return jsonify(product_schema.dump(product)), 201


@products_bp.put("/<int:product_id>")
@jwt_required()
def update_product(product_id: int):
    """PUT /api/products/<id> — edit a product (owner only)."""
    err = _require_owner()
    if err:
        return err

    product = db.get_or_404(Product, product_id)

    try:
        data = product_schema.load(request.get_json(silent=True) or {}, partial=True)
    except ValidationError as e:
        return jsonify({"errors": e.messages}), 422

    # A product's accounting model can't change while open stock exists: a
    # counted crate's bulk_quantity is a loose estimate, so switching it to
    # 'weighed' would make FIFO deduct exact kg against fiction — and switching
    # 'weighed' stock to 'counted' would silently reinterpret exact quantities
    # as estimates. The owner must close the open batches first; new batches
    # then follow the new mode, and closed history stays locked.
    new_mode = data.get("pricing_mode")
    if new_mode is not None and new_mode != product.pricing_mode:
        open_batches = StockBatch.query.filter_by(
            product_id=product.id, status=BatchStatus.open
        ).count()
        if open_batches:
            return jsonify({
                "errors": {
                    "pricing_mode": (
                        "Close all open batches first — the accounting model of open "
                        "stock can't be switched safely. Once they're closed, new "
                        "batches will follow the new mode."
                    )
                }
            }), 422

    # Same family: changing the base unit (kg -> piece -> litre) reinterprets
    # every open batch's quantity_remaining in the new unit. FIFO, cost and
    # stock all read batch quantities as base_unit, so a live switch would
    # silently mis-scale what's on the shelf. Blocked while open batches
    # exist — the owner closes them first, then new batches arrive in the
    # new unit.
    new_unit = data.get("base_unit")
    if new_unit is not None and new_unit != product.base_unit:
        open_batches = StockBatch.query.filter_by(
            product_id=product.id, status=BatchStatus.open
        ).count()
        if open_batches:
            return jsonify({
                "errors": {
                    "base_unit": (
                        "Close all open batches first — changing the base unit "
                        "reinterprets the quantity of every open batch on hand. "
                        "New batches will use the new unit once these are closed."
                    )
                }
            }), 422

    for field in ("name", "category", "base_unit", "pricing_mode", "avg_piece_weight", "sell_price", "reorder_threshold"):
        if field in data:
            setattr(product, field, data[field])

    # Delete-then-recreate price buttons: the till always reads the current
    # list, nothing references a button by id, so wholesale replacement is
    # safe here. Only replaces when the payload includes price_buttons.
    if "price_buttons" in data:
        try:
            product.price_buttons = _build_buttons(data["price_buttons"], product.pricing_mode)
        except ValueError as e:
            return jsonify({"errors": {"price_buttons": str(e)}}), 422
    elif "pricing_mode" in data and product.price_buttons:
        # Mode changed without a new button list — make sure the existing
        # buttons still fit the new mode (kg_amount semantics differ).
        try:
            _build_buttons(
                [
                    {
                        "label": b.label,
                        "kg_amount": float(b.kg_amount) if b.kg_amount is not None else None,
                        "price": float(b.price),
                        "sort_order": b.sort_order,
                    }
                    for b in product.price_buttons
                ],
                product.pricing_mode,
            )
        except ValueError as e:
            return jsonify({"errors": {"price_buttons": str(e)}}), 422

    # Mirrors the create-route rule: a counted product is priced at the till
    # from its buttons — it can't exist without at least one. Guards a raw-API
    # mode switch to 'counted' that sends no buttons.
    if product.pricing_mode == PricingMode.counted and not product.price_buttons:
        return jsonify({
            "errors": {"price_buttons": "Sold-by-piece products need at least one price button."}
        }), 422

    db.session.commit()
    return jsonify(product_schema.dump(product)), 200


@products_bp.get("/<int:product_id>/stock")
@jwt_required()
def product_stock(product_id: int):
    """GET /api/products/<id>/stock — current available stock in base unit."""
    product = db.get_or_404(Product, product_id)
    return jsonify({
        "product_id": product.id,
        "product_name": product.name,
        "base_unit": product.base_unit.value,
        "total_stock": product.total_stock,
        "is_low_stock": product.is_low_stock,
        "reorder_threshold": product.reorder_threshold,
    }), 200
