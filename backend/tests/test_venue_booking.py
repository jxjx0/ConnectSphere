import pytest
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import List, Optional


# ==========================================
# Domain Models & Business Logic
# ==========================================

@dataclass
class BookingRequest:
    booking_id: str
    venue_id: str
    user_id: str
    start_time: datetime
    end_time: datetime
    attendees: int


@dataclass
class Venue:
    venue_id: str
    name: str
    capacity: int
    is_active: bool = True


class VenueBookingService:
    def __init__(self):
        self.venues = {}
        self.bookings = []

    def add_venue(self, venue: Venue):
        self.venues[venue.venue_id] = venue

    def create_booking(self, request: BookingRequest) -> bool:
        # Validate venue exists and is active
        venue = self.venues.get(request.venue_id)
        if not venue or not venue.is_active:
            raise ValueError("Venue not available or does not exist.")

        # Validate time slot
        if request.start_time >= request.end_time:
            raise ValueError("Start time must be before end time.")

        # Validate capacity
        if request.attendees > venue.capacity:
            raise ValueError(f"Attendees exceed venue capacity of {venue.capacity}.")

        # Check for scheduling overlap
        for existing in self.bookings:
            if existing.venue_id == request.venue_id:
                if max(existing.start_time, request.start_time) < min(existing.end_time, request.end_time):
                    raise ValueError("Booking time slot overlaps with an existing reservation.")

        self.bookings.append(request)
        return True


# ==========================================
# Pytest Test Fixtures
# ==========================================

@pytest.fixture
def booking_service():
    """Provides a fresh instance of VenueBookingService with a standard test venue."""
    service = VenueBookingService()
    test_venue = Venue(venue_id="v_101", name="Auditorium A", capacity=100)
    service.add_venue(test_venue)
    return service


@pytest.fixture
def base_time():
    """Provides a consistent future starting timestamp for booking tests."""
    return datetime.now() + timedelta(days=1)


# ==========================================
# Automated Pytest Suite
# ==========================================

def test_successful_booking(booking_service, base_time):
    """Test creating a valid booking without conflicts."""
    request = BookingRequest(
        booking_id="b_001",
        venue_id="v_101",
        user_id="user_1",
        start_time=base_time,
        end_time=base_time + timedelta(hours=2),
        attendees=50
    )
    result = booking_service.create_booking(request)
    assert result is True
    assert len(booking_service.bookings) == 1


def test_booking_exceeds_capacity(booking_service, base_time):
    """Test rejection when attendees exceed venue capacity."""
    request = BookingRequest(
        booking_id="b_002",
        venue_id="v_101",
        user_id="user_2",
        start_time=base_time,
        end_time=base_time + timedelta(hours=1),
        attendees=150  # Capacity is 100
    )
    with pytest.raises(ValueError, match="exceed venue capacity"):
        booking_service.create_booking(request)


def test_booking_invalid_time_range(booking_service, base_time):
    """Test rejection when start time is equal to or after end time."""
    request = BookingRequest(
        booking_id="b_003",
        venue_id="v_101",
        user_id="user_3",
        start_time=base_time + timedelta(hours=2),
        end_time=base_time,  # End before start
        attendees=10
    )
    with pytest.raises(ValueError, match="Start time must be before end time"):
        booking_service.create_booking(request)


def test_booking_overlap_conflict(booking_service, base_time):
    """Test rejection when attempting to double-book an overlapping slot."""
    # Initial successful booking (10:00 - 12:00)
    b1 = BookingRequest(
        booking_id="b_004",
        venue_id="v_101",
        user_id="user_1",
        start_time=base_time,
        end_time=base_time + timedelta(hours=2),
        attendees=20
    )
    booking_service.create_booking(b1)

    # Overlapping booking attempt (11:00 - 13:00)
    b2 = BookingRequest(
        booking_id="b_005",
        venue_id="v_101",
        user_id="user_4",
        start_time=base_time + timedelta(hours=1),
        end_time=base_time + timedelta(hours=3),
        attendees=20
    )
    with pytest.raises(ValueError, match="overlaps with an existing reservation"):
        booking_service.create_booking(b2)


def test_booking_nonexistent_venue(booking_service, base_time):
    """Test rejection when booking a venue that does not exist."""
    request = BookingRequest(
        booking_id="b_006",
        venue_id="v_999",  # Invalid ID
        user_id="user_1",
        start_time=base_time,
        end_time=base_time + timedelta(hours=1),
        attendees=10
    )
    with pytest.raises(ValueError, match="Venue not available or does not exist"):
        booking_service.create_booking(request)


def test_booking_inactive_venue(booking_service, base_time):
    """Test rejection when booking an inactive venue."""
    inactive_venue = Venue(venue_id="v_102", name="Room B", capacity=20, is_active=False)
    booking_service.add_venue(inactive_venue)

    request = BookingRequest(
        booking_id="b_007",
        venue_id="v_102",
        user_id="user_1",
        start_time=base_time,
        end_time=base_time + timedelta(hours=1),
        attendees=5
    )
    with pytest.raises(ValueError, match="Venue not available or does not exist"):
        booking_service.create_booking(request)