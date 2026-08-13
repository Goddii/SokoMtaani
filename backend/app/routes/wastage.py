"""Wastage routes."""
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from marshmallow import ValidationError

from app.extensions import db
from app.models.product import Product
from app.models.wastage import Wastage
from app.routes.sales import _fifo_deduct  # reuse FIFO logic
from app.schemas.wastage_schema import WastageSchema, WastageCreateSchema

wastage_bp = Blueprint("wastage", __name__)
wastage_schema = WastageSchema()
wastage_list_schema = WastageSchema(many=True)
create_schema = WastageCreateSchema()


@wastage_bp.post("")
@jwt_required()
def log_wastage():
    """POST /api/wastage — log wastage and decrement batch quantity_remaining."""
    try:
        data = create_schema.load(request.get_json(silent=True) or {})
    except ValidationError as e:
        return jsonify({"errors": e.messages}), 422

    product = db.get_or_404(Product, data["product_id"])

    # Wastage quantity assumed to be in base_unit already
    qty = data["quantity"]

    try:
        _, batch, _ = _fifo_deduct(product, qty)
    except ValueError as e:
        return jsonify({"error": str(e)}), 422

    # Identity is server-derived from the JWT — never trusted from the client.
    entry = Wastage(
        product_id=product.id,
        batch_id=batch.id,
        quantity=qty,
        reason=data.get("reason", "spoilage"),
        date=data.get("date") or datetime.now(timezone.utc),
        recorded_by=int(get_jwt_identity()),
    )
    db.session.add(entry)
    product.refresh_cost_cache()
    db.session.commit()
    return jsonify(wastage_schema.dump(entry)), 201


@wastage_bp.get("")
@jwt_required()
def list_wastage():
    """GET /api/wastage — list, filterable by ?product_id=&attendant_id=&date="""
    q = Wastage.query

    product_id = request.args.get("product_id", type=int)
    if product_id:
        q = q.filter(Wastage.product_id == product_id)

    attendant_id = request.args.get("attendant_id", type=int)
    if attendant_id:
        q = q.filter(Wastage.recorded_by == attendant_id)

    date_str = request.args.get("date")
    if date_str:
        try:
            day = datetime.strptime(date_str, "%Y-%m-%d").date()
            q = q.filter(db.func.date(Wastage.date) == day)
        except ValueError:
            return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 422

    entries = q.order_by(Wastage.date.desc()).limit(500).all()
    return jsonify(wastage_list_schema.dump(entries)), 200
