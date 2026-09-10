workspace "ConnectSphere - System Context" "C4 Level 1 (v1): who uses the ConnectSphere Event Planning and Venue Booking System, and what it depends on." {

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
        # The system we are building — one software system
        # ---------------------------------------------------------------
        connectSphere = softwareSystem "ConnectSphere Event Planning System" "Manages the event request lifecycle, venue bookings, equipment reservations, attendee registration, and notifications."

        # ---------------------------------------------------------------
        # Things we neither build, own nor operate
        # ---------------------------------------------------------------
        emailService = softwareSystem "Email Delivery Service" "Third-party provider that delivers notification and reminder emails to users' inboxes." "External System"

        # ---------------------------------------------------------------
        # Relationships
        # ---------------------------------------------------------------
        organiser -> connectSphere "Drafts and submits event requests, tracks their status, and requests changes or cancellation"
        attendee -> connectSphere "Signs up, browses events open for registration, registers, and withdraws"
        coordinator -> connectSphere "Reviews assigned requests, searches venues, submits booking requests, records equipment needs, and confirms events"
        venueStaff -> connectSphere "Maintains the venue catalogue and availability, and decides on venue booking requests"
        techStaff -> connectSphere "Reviews equipment requests, checks availability, and reserves equipment for events"

        connectSphere -> emailService "Sends notification and reminder messages for delivery to users"
    }

    views {
        systemContext connectSphere "SystemContext" "The five user groups of ConnectSphere and its one external dependency." {
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
        }
    }
}
