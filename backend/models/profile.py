"""Data shapes and validation for users and their profiles."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator


class Role(str, Enum):
    """Every role a profile row may hold.

    External roles can be self-registered through the signup pages.
    Internal roles are created by the team directly in the Supabase
    dashboard -- there is no admin UI in this release.
    """

    ORGANISER = "organiser"
    ATTENDEE = "attendee"
    COORDINATOR = "coordinator"
    EVENT_COORDINATOR_LEAD = "event_coordinator_lead"
    VENUE_STAFF = "venue_staff"
    TECH_SUPPORT = "tech_support"
    EVENT_COORDINATOR_LEAD = "event_coordinator_lead"


EXTERNAL_ROLES = {Role.ORGANISER, Role.ATTENDEE}


class SignupRequest(BaseModel):
    """The body of POST /signup."""

    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8)
    role: Role
    # Role-specific: contact_number is required for attendees and
    # organisers; organization is required for organisers only. Both live
    # on the shared `profiles` table, populated only for the roles that
    # need them.
    contact_number: str | None = Field(default=None, max_length=30)
    organization: str | None = Field(default=None, max_length=120)

    @field_validator("full_name")
    @classmethod
    def strip_full_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("full_name must not be blank")
        return stripped

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, value: str) -> str:
        """Check the cap here rather than with Field(max_length=72).

        Field's own message is "String should have at most 72 characters",
        which does not say which field it means -- the signup form shows it
        to the user as-is. Raising it ourselves lets us name the field.
        """
        if len(value) > 72:
            raise ValueError("Password should have at most 72 characters")
        return value

    @field_validator("contact_number", "organization")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

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

    @model_validator(mode="after")
    def validate_role_specific_fields(self) -> "SignupRequest":
        """Require each role's own fields, per its signup form's own AC."""
        if self.role in (Role.ATTENDEE, Role.ORGANISER) and not self.contact_number:
            raise ValueError("contact_number must not be blank")
        if self.role == Role.ORGANISER and not self.organization:
            raise ValueError("organization must not be blank")
        return self


class LoginRequest(BaseModel):
    """The body of POST /login."""

    email: EmailStr
    password: str = Field(min_length=1)


class Profile(BaseModel):
    """A row of the `profiles` table.

    contact_number and organization are nullable: populated for attendees
    and organisers (contact_number for both, organization for organisers
    only), null for every other role.
    """

    id: str
    full_name: str
    role: Role
    contact_number: str | None = None
    organization: str | None = None
    created_at: datetime | None = None
