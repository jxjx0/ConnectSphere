"""Venue suitability and availability reads; no booking or block mutations."""

from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from models.venue import Venue
from models.venue_search import OccupiedPeriod, VenueSearchRequest
from services import venue_availability_service as availability
from services.auth_service import AuthError
from services.venue_service import _database_error


def _normalize_accessibility(value: str) -> str:
    name = " ".join(value.split()).casefold()
    # Keep this narrow alias rule aligned with the search dropdown, not venue CRUD.
    return "wheelchair access" if name in {"wheelchair access", "wheelchair accessible"} else name


def _facility_names(value) -> list[str]:
    if isinstance(value, list):
        return [name for name in value if isinstance(name, str) and name.strip()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, dict):
        # Legacy catalogue objects represent availability flags or quantities.
        return [name for name, available in value.items() if name.strip() and (
            available is True or (type(available) in {int, float} and available > 0)
        )]
    return []


def _normalize_facility(value: str) -> str:
    name = " ".join(value.split()).casefold()
    return "wi-fi" if name in {"wi-fi", "wifi", "wi fi"} else name


def search_venues(access_token: str, request: VenueSearchRequest) -> dict:
    client = config.get_user_client(access_token)
    try:
        records = client.table("venues").select("*").order("name").execute().data
        return _search(client, records, request)
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    except (ValidationError, ValueError, KeyError, TypeError, OverflowError) as error:
        raise AuthError("Unable to verify venue availability data.", status_code=502) from error


def _search(client, records, request):
    period = request.period()
    start, end = period if period is not None else (None, None)
    candidates = []
    for record in records:
        venue = Venue(**record)
        if request.required_facility is not None and not any(
            _normalize_facility(name) == _normalize_facility(request.required_facility)
            for name in _facility_names(venue.facilities)
        ):
            continue
        if request.required_accessibility is not None and not any(
            _normalize_accessibility(feature) == _normalize_accessibility(request.required_accessibility)
            for feature in (venue.accessibility or [])
        ):
            continue
        layout = next((layout for layout in venue.layouts
                       if request.required_layout is not None
                       and layout.name.casefold() == request.required_layout.casefold()), None)
        if request.required_layout is not None and layout is None:
            continue
        if request.expected_attendance is not None:
            if venue.capacity < request.expected_attendance:
                continue
            if layout is not None and layout.capacity < request.expected_attendance:
                continue
        buffers = availability.venue_buffers(record) if period is not None else None
        occupied_start, occupied_end = (
            availability.effective_period(start, end, *buffers) if period is not None and buffers is not None
            else (start, end)
        )
        candidates.append((venue, layout, buffers, occupied_start, occupied_end))

    if not candidates:
        return {"venues": [], "warnings": []}

    if period is None:
        return {
            "venues": [_result(venue, layout) for venue, layout, *_ in candidates],
            "warnings": [],
        }

    venue_ids = [venue.id for venue, *_ in candidates]
    blocks = (
        client.table("venue_blocks").select("venue_id, start_at, end_at")
        .in_("venue_id", venue_ids)
        .lt("start_at", max(item[4] for item in candidates).isoformat())
        .gt("end_at", min(item[3] for item in candidates).isoformat())
        .execute().data
    )
    blocks_by_venue = {venue_id: [] for venue_id in venue_ids}
    for block in blocks:
        blocks_by_venue[block["venue_id"]].append(OccupiedPeriod(**block))

    warnings = []
    try:
        occupancy = availability.load_booking_occupancy(client, venue_ids)
        if set(venue_ids) - occupancy.keys():
            raise availability.BookingOccupancyUnavailable(
                "Booking and tentative hold availability is incomplete."
            )
        occupancy = {
            venue_id: [OccupiedPeriod.model_validate(item) for item in occupancy[venue_id]]
            for venue_id in venue_ids
        }
    except availability.BookingOccupancyUnavailable as error:
        occupancy = None
        warnings.append(str(error))
    if any(item[2] is None for item in candidates):
        warnings.append("Setup and turnaround values are unavailable; buffer conflicts cannot yet be verified.")

    results = []
    for venue, layout, buffers, occupied_start, occupied_end in candidates:
        intervals = blocks_by_venue[venue.id]
        if occupancy is not None:
            intervals = intervals + occupancy[venue.id]
        if any(availability.overlaps(occupied_start, occupied_end, interval) for interval in intervals):
            continue
        results.append({
            **_result(venue, layout),
            "availability_status": "available" if occupancy is not None and buffers is not None else "unverified",
            "requested_start": start.isoformat(), "requested_end": end.isoformat(),
            "effective_start": occupied_start.isoformat() if buffers is not None else None,
            "effective_end": occupied_end.isoformat() if buffers is not None else None,
        })
    return {"venues": results, "warnings": warnings}


def _result(venue, layout):
    return {
        "id": venue.id, "name": venue.name, "location": venue.location,
        "capacity": venue.capacity,
        "layouts": [item.model_dump() for item in venue.layouts],
        "facilities": venue.facilities, "accessibility": venue.accessibility,
        "selected_layout": layout.name if layout is not None else None,
        "layout_capacity": layout.capacity if layout is not None else None,
        "availability_status": "not_checked",
        "requested_start": None, "requested_end": None,
        "effective_start": None, "effective_end": None,
    }
