workspace "ConnectSphere - Containers" "C4 Level 2 (v2): the runtime building blocks of the ConnectSphere Event Planning and Venue Booking System." {

    model {
        # ---------------------------------------------------------------
        # People — every user has an authenticated account.
        # Organisers and attendees self-register; the rest are internal.
        # ---------------------------------------------------------------
        organiser = person "Event Organiser" "External client representative who submits event requests, answers clarifications, and requests changes or cancellation." "External User"
        attendee = person "Attendee" "External participant who signs up, browses published events, and registers or withdraws." "External User"
        coordinator = person "Event Coordinator" "Internal staff member assigned to an event; reviews the request, books venues and equipment for each session, and confirms the event." "Internal User"
        coordinatorLead = person "Event Coordinator Lead" "Internal staff member who oversees all coordinators' workload, assigns unassigned events, and reassigns coordinators." "Internal User"
        venueStaff = person "Venue Staff" "Internal staff member who maintains the venue catalogue and availability, and approves or rejects venue booking requests." "Internal User"
        techStaff = person "Technical Support Staff" "Internal staff member who maintains equipment, reviews equipment requests, and allocates units to events." "Internal User"
        safetyOfficer = person "Safety Officer" "Internal staff member who approves, rejects, or requests changes on events before they are confirmed." "Internal User"

        # ---------------------------------------------------------------
        # The system we are building — one software system, three containers
        # ---------------------------------------------------------------
        connectSphere = softwareSystem "ConnectSphere Event Planning System" "Manages the event request lifecycle, coordinator assignment, venue bookings, equipment allocation, safety review, attendee registration, and notifications." {

            spa = container "Web Application" "Role-based UI for all seven user groups: event requests and sessions, review queues, venue search and calendars, equipment allocation, safety review, registration, and the notification inbox." "React 18, Vite, React Router" "Web Browser"

            api = container "API Application" "Enforces the business rules: authorisation by role, event status transitions, coordinator assignment, venue suitability, holds and conflict detection, equipment availability, safety review, registration capacity, and notification triggers." "Python, Flask 3, Pydantic" "API"

            database = container "Supabase" "Stores all application data and user accounts, and issues login tokens." "PostgreSQL + Supabase Auth" "Database"
        }

        # ---------------------------------------------------------------
        # Things we neither build, own nor operate
        # ---------------------------------------------------------------
        emailService = softwareSystem "SendGrid" "Third-party email delivery service that delivers notification emails to users' inboxes." "External System"

        # ---------------------------------------------------------------
        # People -> containers
        # ---------------------------------------------------------------
        organiser -> spa "Submits event requests and tracks their status using" "HTTPS"
        attendee -> spa "Registers for events and manages registrations using" "HTTPS"
        coordinator -> spa "Reviews requests and books venues and equipment using" "HTTPS"
        coordinatorLead -> spa "Monitors workload and reassigns events using" "HTTPS"
        venueStaff -> spa "Maintains venues and decides on booking requests using" "HTTPS"
        techStaff -> spa "Reviews requests and allocates equipment using" "HTTPS"
        safetyOfficer -> spa "Reviews events awaiting a safety check using" "HTTPS"

        # ---------------------------------------------------------------
        # Container -> container / external system
        # ---------------------------------------------------------------
        spa -> api "Reads data from, and submits user actions to, including signup and login" "JSON/HTTPS"

        api -> database "Reads and writes data, and signs users in" "JSON/HTTPS"
        api -> emailService "Sends notification emails triggered by status changes and decisions" "HTTPS (SendGrid Web API)"
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
