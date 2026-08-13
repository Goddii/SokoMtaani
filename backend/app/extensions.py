"""
Flask extensions — instantiated here, initialised in create_app().
Keeps circular imports away from app factory.
"""
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from flask_cors import CORS
import bcrypt as _bcrypt

db = SQLAlchemy()
migrate = Migrate()
jwt = JWTManager()
cors = CORS()


def hash_pin(pin: str) -> str:
    """Hash a 4-digit PIN with bcrypt."""
    return _bcrypt.hashpw(pin.encode(), _bcrypt.gensalt()).decode()


def check_pin(pin: str, pin_hash: str) -> bool:
    """Verify a PIN against its bcrypt hash."""
    return _bcrypt.checkpw(pin.encode(), pin_hash.encode())
