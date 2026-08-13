"""Auth routes — login / logout."""
from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity, get_jwt
from marshmallow import ValidationError

from app.extensions import db, check_pin
from app.models.attendant import Attendant
from app.schemas.attendant_schema import LoginSchema, AttendantSchema

auth_bp = Blueprint("auth", __name__)
login_schema = LoginSchema()
attendant_schema = AttendantSchema()


@auth_bp.post("/login")
def login():
    """
    POST /api/auth/login
    Body: { "attendant_id": 1, "pin": "1234" }
    Returns JWT access token + attendant info.
    """
    try:
        data = login_schema.load(request.get_json(silent=True) or {})
    except ValidationError as err:
        return jsonify({"errors": err.messages}), 422

    attendant = db.session.get(Attendant, data["attendant_id"])
    if not attendant or not attendant.active:
        return jsonify({"error": "Invalid attendant or account inactive."}), 401

    if not check_pin(data["pin"], attendant.pin_hash):
        return jsonify({"error": "Incorrect PIN."}), 401

    # Identity is a string (attendant ID); role stored in additional_claims
    token = create_access_token(
        identity=str(attendant.id),
        additional_claims={"role": attendant.shop_role.value},
    )

    return jsonify({
        "access_token": token,
        "attendant": attendant_schema.dump(attendant),
    }), 200


@auth_bp.post("/logout")
@jwt_required()
def logout():
    """
    POST /api/auth/logout
    JWT is stateless — client should discard the token.
    """
    return jsonify({"message": "Logged out. Discard your token on the client."}), 200


@auth_bp.post("/verify-pin")
@jwt_required()
def verify_pin():
    """
    POST /api/auth/verify-pin
    Body: { "attendant_id": 2, "pin": "3168" }
    Verifies a till PIN without issuing a new token — used to authorise a
    sale at the POS under a specific attendant. 200 on match, 401 otherwise.
    """
    payload = request.get_json(silent=True) or {}
    attendant_id = payload.get("attendant_id")
    pin = payload.get("pin")

    if not isinstance(attendant_id, int) or not isinstance(pin, str) or len(pin) != 4:
        return jsonify({"error": "attendant_id and a 4-digit pin are required."}), 422

    attendant = db.session.get(Attendant, attendant_id)
    if not attendant or not attendant.active:
        return jsonify({"error": "Invalid attendant or account inactive."}), 401

    if not check_pin(pin, attendant.pin_hash):
        return jsonify({"error": "Incorrect PIN."}), 401

    return jsonify({"ok": True, "attendant_id": attendant.id}), 200


@auth_bp.get("/me")
@jwt_required()
def me():
    """GET /api/auth/me — return current attendant info."""
    attendant_id = int(get_jwt_identity())
    attendant = db.session.get(Attendant, attendant_id)
    if not attendant:
        return jsonify({"error": "Attendant not found."}), 404
    return jsonify(attendant_schema.dump(attendant)), 200
