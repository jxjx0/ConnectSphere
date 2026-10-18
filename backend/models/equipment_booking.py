"""Data shapes and validation for equipment time bookings."""

from uuid import UUID

from pydantic import AwareDatetime, BaseModel, model_validator


class EquipmentBookingCreate(BaseModel):
    equipment_id: UUID
    request_id: UUID
    start_at: AwareDatetime
    end_at: AwareDatetime

    @model_validator(mode="after")
    def validate_time_order(self) -> "EquipmentBookingCreate":
        if self.end_at <= self.start_at:
            raise ValueError("Booking end time must be after its start time.")
        return self


class EquipmentBookingRange(BaseModel):
    equipment_id: UUID
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def validate_range(self) -> "EquipmentBookingRange":
        if self.end <= self.start:
            raise ValueError("The range end must be after its start.")
        return self


class EquipmentBookingCalendarRange(BaseModel):
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def validate_range(self) -> "EquipmentBookingCalendarRange":
        if self.end <= self.start:
            raise ValueError("The range end must be after its start.")
        return self
