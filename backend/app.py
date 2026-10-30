"""Flask app factory."""

from flask import Flask, jsonify
from flask_cors import CORS

import config
from routes.attendee_events import attendee_events_bp
from routes.auth import auth_bp
from routes.events import events_bp
from routes.health import health_bp
from routes.notifications import notifications_bp
from routes.venues import venues_bp
from services.auth_service import AuthError

from routes.equipment import equipment_bp
from routes.equipment_bookings import equipment_bookings_bp
from routes.equipment_requests import equipment_requests_bp


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, origins=[config.FRONTEND_ORIGIN])

    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(events_bp)
    app.register_blueprint(venues_bp)
    app.register_blueprint(notifications_bp)
    app.register_blueprint(equipment_bp)
    app.register_blueprint(equipment_requests_bp)
    app.register_blueprint(equipment_bookings_bp)
    app.register_blueprint(attendee_events_bp)

    @app.errorhandler(AuthError)
    def handle_auth_error(error: AuthError):
        """Any AuthError raised in a service or route becomes a JSON reply."""
        return jsonify({"error": error.message}), error.status_code

    return app


if __name__ == "__main__":
    create_app().run(debug=True, port=5000)
