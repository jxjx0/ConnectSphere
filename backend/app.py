"""Flask app factory."""

from flask import Flask, jsonify
from flask_cors import CORS

import config
from routes.auth import auth_bp
from routes.health import health_bp
from services.auth_service import AuthError


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, origins=[config.FRONTEND_ORIGIN])

    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)

    @app.errorhandler(AuthError)
    def handle_auth_error(error: AuthError):
        """Any AuthError raised in a service or route becomes a JSON reply."""
        return jsonify({"error": error.message}), error.status_code

    return app


if __name__ == "__main__":
    create_app().run(debug=True, port=5000)
