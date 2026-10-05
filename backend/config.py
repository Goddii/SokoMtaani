"""
SokoMtaani — Flask configuration.
Environment-based: DevelopmentConfig (SQLite default) → ProductionConfig (PostgreSQL).
"""
import os
from datetime import timedelta

# Load .env file if present (dev convenience)
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def _normalize_pg_url(url: str | None) -> str | None:
    """Rewrite the deprecated ``postgres://`` scheme to ``postgresql://``.

    Required for SQLAlchemy 1.4+ (psycopg2 no longer accepts `postgres://`).
    Applied to both the pooled app URL and the direct migration URL.
    """
    if url and url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


# --- Neon engine-pool constants (production only) ---
# Neon compute suspends after ~5 min idle; pool_pre_ping detects dead
# connections instead of surfacing them as request errors, and pool_recycle
# stays below Neon/PgBouncer idle-suspend thresholds.
_NEON_POOL_PRE_PING = True
_NEON_POOL_RECYCLE = 300       # seconds — must beat Neon idle timeout
_NEON_POOL_SIZE = 5
_NEON_MAX_OVERFLOW = 5
_NEON_CONNECT_TIMEOUT = 10     # seconds — leaves room for cold-start wake-up


class Config:
    # Security — dev fallbacks are for local development only; create_app()
    # refuses to start in production unless both are set via the environment.
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-flask-secret-change-me"
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY") or "dev-jwt-secret-change-me"
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=2)
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
    # DATABASE_URL must be set in the environment (PostgreSQL on Neon).
    # _normalize_pg_url also accepts the deprecated postgres:// scheme.
    SQLALCHEMY_DATABASE_URI = _normalize_pg_url(os.getenv("DATABASE_URL"))

    # Direct (non-pooler) URL for Alembic migrations, pg_dump and pg_restore.
    # DDL must never go through PgBouncer in transaction mode.
    DATABASE_URL_UNPOOLED: str | None = _normalize_pg_url(os.getenv("DATABASE_URL_UNPOOLED"))
    MIGRATION_DATABASE_URI: str | None = DATABASE_URL_UNPOOLED or SQLALCHEMY_DATABASE_URI

    # Neon-safe engine options.  These would break SQLite, so they are
    # scoped to ProductionConfig only.
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": _NEON_POOL_PRE_PING,
        "pool_recycle": _NEON_POOL_RECYCLE,
        "pool_size": _NEON_POOL_SIZE,
        "max_overflow": _NEON_MAX_OVERFLOW,
        "connect_args": {"connect_timeout": _NEON_CONNECT_TIMEOUT},
    }


config = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig,
}
