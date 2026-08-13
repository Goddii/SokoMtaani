from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from marshmallow import ValidationError

from app.extensions import db
from app.models.product import Product
from app.models.stock_batch import StockBatch, BatchStatus
from app.schemas.batch_schema import StockBatchSchema, BatchCreateSchema
from app.utils.unit_conversion import bulk_to_base_unit

batches_bp = Blueprint("batches", __name__)
batch_schema = StockBatchSchema()
batches_schema = StockBatchSchema(many=True)
create_schema = BatchCreateSchema()


def _require_owner():
    claims = get_jwt()
    if claims.get("role") != "owner":
        return jsonify({"error": "Owner access required."}), 403
    return None


@batches_bp.get("")
@jwt_required()
def list_batches():
    """GET /api/batches — list, filterable by ?product_id=&status="""
    q = StockBatch.query.join(Product)

    product_id = request.args.get("product_id", type=int)
    if product_id:
        q = q.filter(StockBatch.product_id == product_id)

    status = request.args.get("status")
    if status in ("open", "closed"):
        q = q.filter(StockBatch.status == BatchStatus(status))

    batches = q.order_by(StockBatch.date_received.desc()).all()
    return jsonify(batches_schema.dump(batches)), 200


@batches_bp.post("")
@jwt_required()
def create_batch():
    """
    POST /api/batches — new bulk purchase entry.
    Auto-computes cost_per_base_unit = total_cost / bulk_quantity.
    """
    err = _require_owner()
    if err:
        return err

    try:
        data = create_schema.load(request.get_json(silent=True) or {})
    except ValidationError as e:
        return jsonify({"errors": e.messages}), 422

    product = db.get_or_404(Product, data["product_id"])

    # Convert bulk quantity to base_unit quantity
    base_qty = bulk_to_base_unit(
        data["bulk_quantity"],
        data["bulk_unit"],
        product.base_unit.value,
    )

    cost_per_base_unit = data["total_cost"] / base_qty if base_qty else 0

    batch = StockBatch(
        product_id=product.id,
        bulk_quantity=data["bulk_quantity"],
        bulk_unit=data["bulk_unit"],
        total_cost=data["total_cost"],
        cost_per_base_unit=cost_per_base_unit,
        quantity_remaining=base_qty,
        date_received=data.get("date_received") or datetime.now(timezone.utc),
        status=BatchStatus.open,
    )
    db.session.add(batch)

    # Refresh product cost cache
    db.session.flush()  # get batch.id
    product.refresh_cost_cache()

    db.session.commit()
    return jsonify(batch_schema.dump(batch)), 201


@batches_bp.put("/<int:batch_id>/close")
@jwt_required()
def close_batch(batch_id: int):
    """PUT /api/batches/<id>/close — manually close a batch."""
    err = _require_owner()
    if err:
        return err

    batch = db.get_or_404(StockBatch, batch_id)

    if batch.status == BatchStatus.closed:
        return jsonify({"error": "Batch is already closed."}), 409

    batch.status = BatchStatus.closed
    batch.closed_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify(batch_schema.dump(batch)), 200
