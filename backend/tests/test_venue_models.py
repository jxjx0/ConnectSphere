"""Venue validation boundaries, shared by profile creation and editing."""

import pytest
from pydantic import ValidationError

from models.venue import (
    OperatingHours,
    VenueCreateRequest,
    VenueLayout,
    VenueUpdateRequest,
)


@pytest.fixture(
    params=[VenueCreateRequest, VenueUpdateRequest], ids=["create", "update"]
)
def request_model(request):
    return request.param


def test_names_location_and_accessibility_are_trimmed(request_model, venue_payload):
    venue_payload.update(
        name="  Community Hall  ",
        location="  Campus West  ",
        accessibility=["  Step-free access  ", " Hearing loop "],
        layouts=[{"name": " Theatre ", "capacity": 120}],
    )

    result = request_model(**venue_payload)

    assert result.name == "Community Hall"
    assert result.location == "Campus West"
    assert result.accessibility == ["Step-free access", "Hearing loop"]
    assert result.layouts[0].name == "Theatre"


@pytest.mark.parametrize("location", [None, "", "   ", "\t\n"])
def test_optional_location_can_be_absent_or_blank(
    request_model, venue_payload, location
):
    venue_payload["location"] = location

    assert request_model(**venue_payload).location is None


@pytest.mark.parametrize("accessibility", [None, []])
def test_optional_accessibility_can_be_absent_or_empty(
    request_model, venue_payload, accessibility
):
    venue_payload["accessibility"] = accessibility

    assert request_model(**venue_payload).accessibility == accessibility


@pytest.mark.parametrize("name", ["", " ", "\t\n", "x" * 201])
def test_invalid_venue_names_are_rejected(request_model, venue_payload, name):
    venue_payload["name"] = name

    with pytest.raises(ValidationError) as caught:
        request_model(**venue_payload)

    assert any(error["loc"] == ("name",) for error in caught.value.errors())


@pytest.mark.parametrize("name", ["", " ", "\t\n", "x" * 121])
def test_invalid_layout_names_are_rejected(name):
    with pytest.raises(ValidationError) as caught:
        VenueLayout(name=name, capacity=1)

    assert any(error["loc"] == ("name",) for error in caught.value.errors())


@pytest.mark.parametrize("name", ["x", "x" * 120])
def test_layout_names_at_length_boundaries_are_accepted(name):
    assert VenueLayout(name=name, capacity=1).name == name


@pytest.mark.parametrize("name", ["x", "x" * 200])
def test_venue_names_at_length_boundaries_are_accepted(
    request_model, venue_payload, name
):
    venue_payload["name"] = name

    assert request_model(**venue_payload).name == name


@pytest.mark.parametrize("features", [[""], [" "], ["Ramp", "\t"]])
def test_blank_accessibility_features_are_rejected(
    request_model, venue_payload, features
):
    venue_payload["accessibility"] = features

    with pytest.raises(
        ValidationError, match="accessibility features must not be blank"
    ):
        request_model(**venue_payload)


@pytest.mark.parametrize("names", [("Theatre", "Theatre"), ("Theatre", " theatre ")])
def test_layout_names_must_be_unique_after_normalization(
    request_model, venue_payload, names
):
    venue_payload["layouts"] = [{"name": name, "capacity": 1} for name in names]

    with pytest.raises(ValidationError, match="layout names must be unique"):
        request_model(**venue_payload)


@pytest.mark.parametrize("capacity", [-1, 0])
def test_non_positive_venue_capacity_is_rejected(
    request_model, venue_payload, capacity
):
    venue_payload["capacity"] = capacity

    with pytest.raises(ValidationError) as caught:
        request_model(**venue_payload)

    assert any(error["loc"] == ("capacity",) for error in caught.value.errors())


@pytest.mark.parametrize("capacity", [-1, 0])
def test_non_positive_layout_capacity_is_rejected(capacity):
    with pytest.raises(ValidationError) as caught:
        VenueLayout(name="Theatre", capacity=capacity)

    assert any(error["loc"] == ("capacity",) for error in caught.value.errors())


@pytest.mark.parametrize("capacity", [2, 25, 500])
@pytest.mark.parametrize("difference", [-1, 0], ids=["below", "equal"])
def test_layout_capacity_at_or_below_venue_capacity_is_accepted(
    request_model, venue_payload, capacity, difference
):
    layout_capacity = capacity + difference
    venue_payload.update(
        capacity=capacity,
        layouts=[{"name": "Theatre", "capacity": layout_capacity}],
    )

    result = request_model(**venue_payload)

    assert result.capacity == capacity
    assert result.layouts[0].capacity == layout_capacity


@pytest.mark.parametrize("capacity", [2, 25, 500])
def test_layout_capacity_above_venue_capacity_is_rejected(
    request_model, venue_payload, capacity
):
    venue_payload.update(
        capacity=capacity,
        layouts=[{"name": "Theatre", "capacity": capacity + 1}],
    )

    with pytest.raises(ValidationError, match="layout capacity cannot exceed"):
        request_model(**venue_payload)


def test_a_later_layout_cannot_exceed_venue_capacity(request_model, venue_payload):
    capacity = venue_payload["capacity"]
    venue_payload["layouts"] = [
        {"name": "Theatre", "capacity": capacity - 1},
        {"name": "Banquet", "capacity": capacity + 1},
    ]

    with pytest.raises(ValidationError, match="layout capacity cannot exceed"):
        request_model(**venue_payload)


@pytest.mark.parametrize("field", ["name", "capacity", "layouts", "operating_hours"])
def test_required_venue_fields_cannot_be_omitted(request_model, venue_payload, field):
    venue_payload.pop(field)

    with pytest.raises(ValidationError) as caught:
        request_model(**venue_payload)

    assert any(
        error["loc"] == (field,) and error["type"] == "missing"
        for error in caught.value.errors()
    )


def test_at_least_one_layout_is_required(request_model, venue_payload):
    venue_payload["layouts"] = []

    with pytest.raises(ValidationError) as caught:
        request_model(**venue_payload)

    assert any(error["loc"] == ("layouts",) for error in caught.value.errors())


@pytest.mark.parametrize("field", ["open", "close"])
@pytest.mark.parametrize(
    "invalid_time", ["8:00", "08:0", "08-00", "25:00", "08:60", "aa:bb"]
)
def test_operating_hours_require_valid_hour_minute_values(field, invalid_time):
    hours = {"open": "08:00", "close": "20:00", field: invalid_time}

    with pytest.raises(ValidationError, match="operating hours must use HH:MM values"):
        OperatingHours(**hours)


@pytest.mark.parametrize("opening,closing", [("08:00", "08:00"), ("20:00", "08:00")])
def test_closing_time_must_follow_opening_time(opening, closing):
    with pytest.raises(ValidationError, match="close time must be after open time"):
        OperatingHours(open=opening, close=closing)


@pytest.mark.parametrize("opening,closing", [("00:00", "23:59"), ("08:00", "08:01")])
def test_valid_operating_hours_are_preserved(opening, closing):
    hours = OperatingHours(open=opening, close=closing)

    assert hours.model_dump() == {"open": opening, "close": closing}
