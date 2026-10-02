"""Shared authorization helpers for route modules."""
from functools import wraps

from flask import jsonify
from flask_jwt_extended import get_jwt, verify_jwt_in_request

OWNER_ROLE = "owner"


def is_owner() -> bool:
    """True when the current (already verified) JWT carries the owner role."""
    return get_jwt().get("role") == OWNER_ROLE


def owner_required(fn):
    """Require a valid JWT *and* the owner role. Replaces @jwt_required()."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        if not is_owner():
            return jsonify({"error": "Owner access required."}), 403
        return fn(*args, **kwargs)

    return wrapper
