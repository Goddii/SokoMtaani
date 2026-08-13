"""Attendants routes."""
from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt

from app.extensions import db, hash_pin
from app.models.attendant import Attendant
from app.schemas.attendant_schema import AttendantSchema

attendants_bp = Blueprint("attendants", __name__)
attendant_schema = AttendantSchema()
attendants_schema = AttendantSchema(many=True)


def _require_owner():
    claims = get_jwt()
    if claims.get("role") != "owner":
        return jsonify({"error": "Owner access required."}), 403
    return None


@attendants_bp.get("")
@jwt_required()
def list_attendants():
    """GET /api/attendants — list all attendants."""
    attendants = Attendant.query.order_by(Attendant.id).all()
    return jsonify(attendants_schema.dump(attendants)), 200


@attendants_bp.post("/<int:attendant_id>/reset-pin")
@jwt_required()
def reset_pin(attendant_id: int):
    """POST /api/attendants/<id>/reset-pin — reset an attendant's PIN (owner only)."""
    err = _require_owner()
    if err:
        return err

    payload = request.get_json(silent=True) or {}
    new_pin = payload.get("pin")
    if not new_pin or len(new_pin) != 4 or not new_pin.isdigit():
        return jsonify({"error": "A 4-digit PIN is required."}), 422

    attendant = db.get_or_404(Attendant, attendant_id)
    attendant.pin_hash = hash_pin(new_pin)
    db.session.commit()

    return jsonify({"message": "PIN reset successfully."}), 200
