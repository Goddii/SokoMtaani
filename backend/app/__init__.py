"""
SokoMtaani — Flask app factory.
"""
import os

from flask import Flask
from config import config
from app.extensions import db, migrate, jwt, cors


def create_app(env: str = "development") -> Flask:
    app = Flask(__name__)
    app.config.from_object(config[env])

    # Fail fast: production must never run on the public development secrets.
    if env == "production":
        missing = [k for k in ("SECRET_KEY", "JWT_SECRET_KEY") if not os.getenv(k)]
        if missing:
            raise RuntimeError(
                "Missing required environment variable(s) for production: "
                + ", ".join(missing)
                + ". Refusing to start with development fallback secrets."
            )

    # ---------- Extensions ----------
    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cors.init_app(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=True,
    )

    # ---------- Import models so Migrate can detect them ----------
    from app.models import (  # noqa: F401
        attendant,
        product,
        price_button,
        stock_batch,
        sale,
        wastage,
    )

    # ---------- Register blueprints ----------
    from app.routes.auth import auth_bp
    from app.routes.products import products_bp
    from app.routes.batches import batches_bp
    from app.routes.sales import sales_bp
    from app.routes.wastage import wastage_bp
    from app.routes.attendants import attendants_bp
    from app.routes.dashboard import dashboard_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(products_bp, url_prefix="/api/products")
    app.register_blueprint(batches_bp, url_prefix="/api/batches")
    app.register_blueprint(sales_bp, url_prefix="/api/sales")
    app.register_blueprint(wastage_bp, url_prefix="/api/wastage")
    app.register_blueprint(attendants_bp, url_prefix="/api/attendants")
    app.register_blueprint(dashboard_bp, url_prefix="/api/dashboard")

    # ---------- Health check ----------
    @app.get("/api/health")
    def health():
        return {"status": "ok", "app": "SokoMtaani"}

    return app
