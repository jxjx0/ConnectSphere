"""Auth endpoints. Thin handlers: parse, call the service, return JSON."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.profile import LoginRequest, SignupRequest
from services import auth_service
from services.auth_service import AuthError

auth_bp = Blueprint("auth", __name__)


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _bearer_token() -> str:
    """Pull the access token out of the Authorization header."""
    header = request.headers.get("Authorization", "")
    if not header or not header.strip():
        raise AuthError("Missing bearer token.", status_code=401)

    parts = header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise AuthError("Missing bearer token.", status_code=401)
    return parts[1]


def require_auth(view):
    """Protect a route: verify the token before the handler runs.

    Sets `g.user_id` and `g.access_token` for the handler to use. This is
    the real security boundary -- the frontend AuthGuard only decides what
    to render.
    """

    def wrapper(*args, **kwargs):
        token = _bearer_token()
        g.access_token = token
        g.user_id = auth_service.get_user_id(token)
        return view(*args, **kwargs)

    wrapper.__name__ = view.__name__
    return wrapper


@auth_bp.post("/signup")
def signup():
    try:
        signup_request = SignupRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    result = auth_service.signup(signup_request)
    return (
        jsonify(
            {
                "access_token": result["access_token"],
                "profile": result["profile"].model_dump(mode="json"),
            }
        ),
        201,
    )


@auth_bp.post("/login")
def login():
    try:
        login_request = LoginRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    result = auth_service.login(login_request)
    return (
        jsonify(
            {
                "access_token": result["access_token"],
                "profile": result["profile"].model_dump(mode="json"),
            }
        ),
        200,
    )


@auth_bp.get("/me")
@require_auth
def me():
    profile = auth_service.get_profile(g.access_token, g.user_id)
    return jsonify({"profile": profile.model_dump(mode="json")}), 200
