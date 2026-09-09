"""Data shapes and validation for users and their profiles."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, EmailStr, Field, field_validator


class Role(str, Enum):
    """Every role a profile row may hold.

    External roles can be self-registered through the signup pages.
    Internal roles are created by the team directly in the Supabase
    dashboard -- there is no admin UI in this release.
    """

    ORGANISER = "organiser"
    ATTENDEE = "attendee"
    COORDINATOR = "coordinator"
    VENUE_STAFF = "venue_staff"
    TECH_SUPPORT = "tech_support"


EXTERNAL_ROLES = {Role.ORGANISER, Role.ATTENDEE}


class SignupRequest(BaseModel):
    """The body of POST /signup."""

    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: Role

    @field_validator("full_name")
    @classmethod
    def strip_full_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("full_name must not be blank")
        return stripped

    @field_validator("role")
    @classmethod
    def validate_external_role(cls, value: Role) -> Role:
        """Reject signup as an internal role.

        This is the real boundary, enforced on the server: it holds no
        matter what the frontend sends.
        """
        if value not in EXTERNAL_ROLES:
            raise ValueError(
                f"'{value.value}' accounts cannot be self-registered. "
                "Contact the ConnectSphere team."
            )
        return value


class LoginRequest(BaseModel):
    """The body of POST /login."""

    email: EmailStr
    password: str = Field(min_length=1)


class Profile(BaseModel):
    """A row of the `profiles` table."""

    id: str
    full_name: str
    role: Role
    created_at: datetime | None = None
