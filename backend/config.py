"""
SokoMtaani — Flask configuration.
Environment-based: DevelopmentConfig (SQLite default) → ProductionConfig (PostgreSQL).
"""
import os
from datetime import timedelta

# Load .env file if present (dev convenience)
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


class Config:
    # Security — dev fallbacks are for local development only; create_app()
    # refuses to start in production unless both are set via the environment.
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-flask-secret-change-me"
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY") or "dev-jwt-secret-change-me"
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=12)
    JWT_TOKEN_LOCATION = ["headers"]

    # SQLAlchemy
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # CORS — Vite dev server origin by default
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

    # Business logic
    LOW_MARGIN_THRESHOLD = float(os.getenv("LOW_MARGIN_THRESHOLD", "0.10"))

    # Business timezone — all "today"/business-day calculations use this
    SHOP_TIMEZONE = os.getenv("SHOP_TIMEZONE", "Africa/Nairobi")

    # Pagination
    DEFAULT_PAGE_SIZE = 100


class DevelopmentConfig(Config):
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        f"sqlite:///{os.path.join(os.path.dirname(__file__), 'sokomtaani_dev.db')}",
    )
    # Echo SQL in development for debugging
    SQLALCHEMY_ECHO = False


class ProductionConfig(Config):
    DEBUG = False
    # DATABASE_URL must be set in the environment (PostgreSQL)
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")
    if SQLALCHEMY_DATABASE_URI and SQLALCHEMY_DATABASE_URI.startswith("postgres://"):
        # Fix deprecated postgres:// scheme for SQLAlchemy 1.4+
        SQLALCHEMY_DATABASE_URI = SQLALCHEMY_DATABASE_URI.replace(
            "postgres://", "postgresql://", 1
        )


config = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig,
}
