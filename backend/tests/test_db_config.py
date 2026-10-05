"""\
Regression tests — Neon DB configuration.

Covers:
  - postgres:// -> postgresql:// rewrite for both DATABASE_URL and DATABASE_URL_UNPOOLED.
  - ProductionConfig.SQLALCHEMY_ENGINE_OPTIONS sets pool_pre_ping / pool_recycle.
  - DevelopmentConfig has no pool_size or SQLALCHEMY_ENGINE_OPTIONS (SQLite is safe).
  - create_app("production") with no DATABASE_URL raises a clear error.

Run from anywhere:
    python3 backend/tests/test_db_config.py

Plain asserts with a standalone main (same convention as the other tests here).
"""
import os
import sys
import importlib

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)


class _Checks:
    def __init__(self):
        self.failures: list[str] = []

    def check(self, cond: bool, label: str) -> None:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
        if not cond:
            self.failures.append(label)

    def done(self) -> None:
        if self.failures:
            raise SystemExit(f"FAILED: {len(self.failures)} check(s): {', '.join(self.failures)}")
        print("  ALL CHECKS PASSED")


def test_pg_url_rewrite():
    """_normalize_pg_url must rewrite postgres:// -> postgresql:// for both URLs."""
    from config import _normalize_pg_url

    checks = _Checks()
    checks.check(
        _normalize_pg_url("postgres://user:pass@host:5432/db") == "postgresql://user:pass@host:5432/db",
        "postgres:// rewritten to postgresql://",
    )
    checks.check(
        _normalize_pg_url("postgresql://user:pass@host:5432/db") == "postgresql://user:pass@host:5432/db",
        "postgresql:// left unchanged",
    )
    checks.check(
        _normalize_pg_url("postgres://neon.example.com/db") == "postgresql://neon.example.com/db",
        "rewrite works for Neon-style URLs",
    )
    checks.check(
        _normalize_pg_url("sqlite:///sokomtaani_dev.db") == "sqlite:///sokomtaani_dev.db",
        "SQLite URL left unchanged",
    )
    checks.check(
        _normalize_pg_url(None) is None,
        "None stays None",
    )
    checks.done()


def test_production_engine_options():
    """ProductionConfig must set pool_pre_ping, pool_recycle and a direct migration URL."""
    import config as config_module

    checks = _Checks()
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "DATABASE_URL_UNPOOLED")}
    try:
        os.environ["DATABASE_URL"] = "postgres://user:pass@ep-pooled.example.neon.tech/neondb?sslmode=require"
        os.environ["DATABASE_URL_UNPOOLED"] = "postgres://user:pass@ep-direct.example.neon.tech/neondb?sslmode=require"
        importlib.reload(config_module)

        opts = config_module.ProductionConfig.SQLALCHEMY_ENGINE_OPTIONS
        checks.check(opts["pool_pre_ping"] is True, "pool_pre_ping is True")
        checks.check(opts["pool_recycle"] == 300, "pool_recycle is 300")
        checks.check(opts["pool_size"] == 5, "pool_size is 5")
        checks.check(opts["max_overflow"] == 5, "max_overflow is 5")
        checks.check(opts["connect_args"]["connect_timeout"] == 10, "connect_timeout is 10")

        checks.check(
            config_module.ProductionConfig.SQLALCHEMY_DATABASE_URI
            == "postgresql://user:pass@ep-pooled.example.neon.tech/neondb?sslmode=require",
            "DATABASE_URL is normalized (postgres:// -> postgresql://)",
        )
        checks.check(
            config_module.ProductionConfig.MIGRATION_DATABASE_URI
            == "postgresql://user:pass@ep-direct.example.neon.tech/neondb?sslmode=require",
            "MIGRATION_DATABASE_URI comes from DATABASE_URL_UNPOOLED, normalized",
        )
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(config_module)
    checks.done()


def test_production_engine_options_missing_unpooled():
    """When DATABASE_URL_UNPOOLED is unset, MIGRATION_DATABASE_URI falls back to the pooled URL."""
    import config as config_module

    checks = _Checks()
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "DATABASE_URL_UNPOOLED")}
    try:
        os.environ["DATABASE_URL"] = "postgres://user:pass@ep-pooled.example.neon.tech/neondb?sslmode=require"
        os.environ["DATABASE_URL_UNPOOLED"] = ""
        importlib.reload(config_module)

        checks.check(
            config_module.ProductionConfig.MIGRATION_DATABASE_URI
            == "postgresql://user:pass@ep-pooled.example.neon.tech/neondb?sslmode=require",
            "MIGRATION_DATABASE_URI falls back to pooled URL when unpooled is empty",
        )
        checks.check(
            config_module.ProductionConfig.SQLALCHEMY_DATABASE_URI == config_module.ProductionConfig.MIGRATION_DATABASE_URI,
            "Both URLs match when DATABASE_URL_UNPOOLED is empty",
        )
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(config_module)
    checks.done()


def test_development_has_no_pool_settings():
    """DevelopmentConfig (SQLite) must NOT set pool_size or SQLALCHEMY_ENGINE_OPTIONS."""
    import config as config_module

    checks = _Checks()
    checks.check(
        not hasattr(config_module.DevelopmentConfig, "SQLALCHEMY_ENGINE_OPTIONS"),
        "DevelopmentConfig has no SQLALCHEMY_ENGINE_OPTIONS",
    )
    checks.check(
        not hasattr(config_module.DevelopmentConfig, "pool_size"),
        "DevelopmentConfig has no pool_size",
    )
    checks.check(
        not hasattr(config_module.Config, "SQLALCHEMY_ENGINE_OPTIONS"),
        "Base Config has no SQLALCHEMY_ENGINE_OPTIONS",
    )
    checks.done()


def test_production_requires_database_url():
    """create_app("production") must fail fast when DATABASE_URL is missing."""
    from app import create_app

    checks = _Checks()
    saved = {k: os.environ.get(k) for k in ("SECRET_KEY", "JWT_SECRET_KEY", "DATABASE_URL")}
    try:
        os.environ["SECRET_KEY"] = "test-secret"
        os.environ["JWT_SECRET_KEY"] = "test-jwt-secret"
        os.environ.pop("DATABASE_URL", None)
        try:
            create_app("production")
            checks.check(False, "should have raised RuntimeError")
        except RuntimeError as e:
            checks.check(
                "DATABASE_URL is required in production" in str(e),
                f"error mentions DATABASE_URL (got: {e})",
            )
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    checks.done()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print("ALL TESTS PASSED")
