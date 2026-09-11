workspace "ConnectSphere - Containers" "C4 Level 2 (v1): the runtime building blocks of the ConnectSphere Event Planning and Venue Booking System." {

    model {
        # ---------------------------------------------------------------
        # People (briefing Sec 3 — every user has an authenticated account)
        # ---------------------------------------------------------------
        organiser = person "Event Organiser" "External client representative who submits an event request, supplies requirements, and requests changes." "External User"
        attendee = person "Attendee" "External participant who signs up, registers for an event, and views confirmed event information." "External User"
        coordinator = person "Event Coordinator" "Internal staff member assigned to an event; reviews requests, searches venues, submits booking requests, records equipment needs, and confirms the event." "Internal User"
        venueStaff = person "Venue Staff" "Internal staff member who maintains the venue catalogue and availability, and approves or rejects venue booking requests." "Internal User"
        techStaff = person "Technical Support Staff" "Internal staff member who reviews equipment requests, checks availability, and reserves equipment for an event." "Internal User"

        # ---------------------------------------------------------------
        # The system we are building — one software system, four containers
        # ---------------------------------------------------------------
        connectSphere = softwareSystem "ConnectSphere Event Planning System" "Manages the event request lifecycle, venue bookings, equipment reservations, attendee registration, and notifications." {

            spa = container "Web Application" "Role-based UI for all five user groups: event requests, review, venue calendar and search, equipment, registration, and dashboards." "React 18 (Vite), react-router-dom" "Web Browser"

            api = container "API Application" "Enforces the business rules: authorisation by role, event status transitions, automatic event assignments, venue suitability and conflict detection, equipment availability, registration capacity, and notification triggers. Layered as routes -> services -> models." "Python 3, Flask 3, Pydantic" "API"

            database = container "Application Database" "Stores profiles, events, venues, bookings, equipment, reservations, registrations, notifications, and the change/activity history used for auditability." "Supabase Postgres (managed PostgreSQL, row-level security)" "Database"

            authService = container "Authentication Service" "Stores credentials, issues and validates JWT access tokens, and provides the user identity that each account's role is attached to." "Supabase Auth (GoTrue)" "Auth"
        }

        # ---------------------------------------------------------------
        # Things we neither build, own nor operate
        # ---------------------------------------------------------------
        emailService = softwareSystem "Email Delivery Service" "Third-party provider that delivers notification and reminder emails to users' inboxes." "External System"

        # ---------------------------------------------------------------
        # People -> containers
        # ---------------------------------------------------------------
        organiser -> spa "Drafts and submits event requests, and tracks their status, using" "HTTPS"
        attendee -> spa "Registers for events and manages registrations using" "HTTPS"
        coordinator -> spa "Reviews requests, searches venues, and manages event arrangements using" "HTTPS"
        venueStaff -> spa "Maintains venues and decides on booking requests using" "HTTPS"
        techStaff -> spa "Reviews and reserves equipment using" "HTTPS"

        # ---------------------------------------------------------------
        # Container -> container / external system
        # ---------------------------------------------------------------
        spa -> api "Reads event, venue, equipment, registration, and notification data from, and submits user actions to" "JSON/HTTPS"
        spa -> authService "Refreshes the access token used to authenticate API calls" "JSON/HTTPS"

        api -> authService "Verifies the JWT on every protected request, and creates accounts and sessions at signup and login" "JSON/HTTPS"
        api -> database "Reads and writes event, venue, booking, equipment, registration, and audit records" "PostgREST over HTTPS"
        api -> emailService "Sends notification and reminder emails triggered by status changes, booking decisions, and registration updates" "SMTP/HTTPS"

        authService -> database "Stores user identities and credentials in" "Internal (Postgres auth schema)"
    }

    views {
        container connectSphere "Containers" "The runtime building blocks of the ConnectSphere system." {
            include *
            autoLayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "External User" {
                background #6b8fb5
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "External System" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Web Browser" {
                shape WebBrowser
            }
            element "Database" {
                shape Cylinder
            }
        }
    }
}
