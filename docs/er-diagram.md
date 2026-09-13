This is Mermaid code: renders automatically as a diagram wherever Mermaid is supported (e.g. GitHub, this Markdown viewer).

```mermaid
erDiagram
    PROFILES ||--o{ EVENTS : "organises (organiser_id)"
    PROFILES ||--o{ EVENTS : "coordinates (coordinator_id)"
    PROFILES ||--o{ EVENT_COORDINATOR_ASSIGNMENTS : "assigned as coordinator"
    EVENTS ||--o{ EVENT_COORDINATOR_ASSIGNMENTS : "assignment history"
    EVENTS ||--o{ VENUE_BOOKINGS : requests
    VENUES ||--o{ VENUE_BOOKINGS : "booked for"
    PROFILES ||--o{ VENUE_BOOKINGS : "decided by (venue staff)"
    EVENTS ||--o{ EQUIPMENT_RESERVATIONS : requests
    EQUIPMENT ||--o{ EQUIPMENT_RESERVATIONS : "reserved for"
    PROFILES ||--o{ EQUIPMENT_RESERVATIONS : "decided by (tech support)"
    EVENTS ||--o{ REGISTRATIONS : accepts
    PROFILES ||--o{ REGISTRATIONS : "registers as attendee"
    EVENTS ||--o{ EVENT_CHANGE_REQUESTS : "amended via"
    PROFILES ||--o{ EVENT_CHANGE_REQUESTS : requests
    PROFILES ||--o{ EVENT_CHANGE_REQUESTS : "decided by (coordinator)"
    PROFILES ||--o{ NOTIFICATIONS : receives
    EVENTS ||--o{ NOTIFICATIONS : "relates to"

    PROFILES {
        uuid id PK
        text full_name
        text role "organiser, attendee, coordinator, venue_staff, tech_support"
        text contact_number "nullable, required for attendee + organiser at signup"
        text organization "nullable, required for organiser at signup"
        timestamptz created_at
    }

    EVENTS {
        uuid id PK
        uuid organiser_id FK "must reference a profile with role=organiser"
        uuid coordinator_id FK "must reference a profile with role=coordinator"
        text name
        text purpose
        text description
        timestamptz start_time
        timestamptz end_time
        int expected_attendance
        text layout_preference
        text accessibility_requirements
        text status "draft, requested, planning, confirmed, completed, rejected, cancelled, returned"
        text review_notes "coordinator's clarification/amendment request to the organiser"
        bool is_draft
        bool registration_enabled
        int registration_capacity
        timestamptz registration_deadline
        timestamptz created_at
    }

    EVENT_COORDINATOR_ASSIGNMENTS {
        uuid id PK
        uuid event_id FK
        uuid coordinator_id FK "must reference a profile with role=coordinator"
        timestamptz assigned_at
    }

    VENUES {
        uuid id PK
        text name
        text location
        int capacity
        jsonb facilities
        jsonb accessibility
        jsonb layouts
        jsonb operating_hours
    }

    VENUE_BOOKINGS {
        uuid id PK
        uuid event_id FK
        uuid venue_id FK
        text status "tentative, confirmed, rejected"
        text decision_reason
        uuid decided_by FK "must reference a profile with role=venue_staff"
        timestamptz decided_at
        timestamptz start_time
        timestamptz end_time
    }

    EQUIPMENT {
        uuid id PK
        text name
        text type
        int quantity_total
        text maintenance_status
    }

    EQUIPMENT_RESERVATIONS {
        uuid id PK
        uuid event_id FK
        uuid equipment_id FK
        int quantity_requested
        text technical_requirements
        text status "requested, reserved, rejected"
        text decision_reason
        uuid decided_by FK "must reference a profile with role=tech_support"
        timestamptz decided_at
    }

    REGISTRATIONS {
        uuid id PK
        uuid event_id FK
        uuid attendee_id FK "must reference a profile with role=attendee; unique per event"
        text status "registered, withdrawn"
        timestamptz registered_at
    }

    EVENT_CHANGE_REQUESTS {
        uuid id PK
        uuid event_id FK
        uuid requested_by FK "must reference a profile with role=organiser"
        text change_type
        text details
        text status "requested, approved, rejected"
        text decision_reason
        uuid decided_by FK "must reference a profile with role=coordinator"
        timestamptz requested_at
        timestamptz decided_at
    }

    NOTIFICATIONS {
        uuid id PK
        uuid user_id FK
        uuid event_id FK
        text type
        text message
        timestamptz read_at
        timestamptz created_at
    }
```
