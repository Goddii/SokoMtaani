"""
SokoMtaani — development entry point.
Run:  flask run  or  python run.py
Production: gunicorn "app:create_app('production')"
"""
import os
from app import create_app

env = os.getenv("FLASK_ENV", "development")
app = create_app(env)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=app.config["DEBUG"])
