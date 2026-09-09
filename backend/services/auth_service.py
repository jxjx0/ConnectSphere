"""Authentication logic: signup, login, and reading the current profile.

All Supabase calls live in this layer. Routes stay thin and never talk to
Supabase directly.
"""

from supabase import AuthApiError

import config
from models.profile import LoginRequest, Profile, SignupRequest


class AuthError(Exception):
    """An auth failure that should be reported to the caller.

    `status_code` is the HTTP status the route should return.
    """

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def signup(request: SignupRequest) -> dict:
    """Create an auth user, then their profile row.

    Returns the access token and profile, so the frontend can treat signup
    as "signed up and logged in" without a second request.
    """
    client = config.get_client()

    try:
        result = client.auth.sign_up(
            {"email": request.email, "password": request.password}
        )
    except AuthApiError as error:
        # Most commonly: the email is already registered. One email = one
        # role, so there is no second account to create.
        raise AuthError(error.message, status_code=400) from error

    if result.user is None or result.session is None:
        # Supabase withholds a session when email confirmation is switched
        # on. Sprint 0 has no verification step, so this means the project
        # is misconfigured rather than the request being bad.
        raise AuthError(
            "Signup did not return a session. Check that email confirmation "
            "is disabled in the Supabase dashboard.",
            status_code=502,
        )

    access_token = result.session.access_token

    # Written with the new user's own token, so the insert passes the
    # profiles row-level security policy (a user may only insert their own
    # row). If this fails the auth user already exists without a profile --
    # the team clears that up in the Supabase dashboard.
    user_client = config.get_user_client(access_token)
    inserted = (
        user_client.table("profiles")
        .insert(
            {
                "id": result.user.id,
                "full_name": request.full_name,
                "role": request.role.value,
            }
        )
        .execute()
    )

    return {
        "access_token": access_token,
        "profile": Profile(**inserted.data[0]),
    }


def login(request: LoginRequest) -> dict:
    """Exchange email and password for an access token and profile."""
    client = config.get_client()

    try:
        result = client.auth.sign_in_with_password(
            {"email": request.email, "password": request.password}
        )
    except AuthApiError as error:
        raise AuthError("Invalid email or password.", status_code=401) from error

    if result.user is None or result.session is None:
        raise AuthError("Invalid email or password.", status_code=401)

    access_token = result.session.access_token
    return {
        "access_token": access_token,
        "profile": get_profile(access_token, result.user.id),
    }


def get_user_id(access_token: str) -> str:
    """Return the user id the token belongs to, or raise if it is not valid.

    Supabase verifies the token's signature and expiry -- this is the check
    that makes a route actually protected.
    """
    client = config.get_client()
    try:
        result = client.auth.get_user(access_token)
    except AuthApiError as error:
        raise AuthError("Invalid or expired token.", status_code=401) from error

    if result is None or result.user is None:
        raise AuthError("Invalid or expired token.", status_code=401)

    return result.user.id


def get_profile(access_token: str, user_id: str) -> Profile:
    """Read one profile row, as the user who owns it."""
    user_client = config.get_user_client(access_token)
    result = (
        user_client.table("profiles").select("*").eq("id", user_id).execute()
    )

    if not result.data:
        raise AuthError("No profile found for this user.", status_code=404)

    return Profile(**result.data[0])
