workspace "ConnectSphere - System Context" "C4 Level 1 (v2): who uses the ConnectSphere Event Planning and Venue Booking System, and what it depends on." {

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
        # The system we are building — one software system
        # ---------------------------------------------------------------
        connectSphere = softwareSystem "ConnectSphere Event Planning System" "Manages the event request lifecycle, coordinator assignment, venue bookings, equipment allocation, safety review, attendee registration, and notifications."

        # ---------------------------------------------------------------
        # Things we neither build, own nor operate
        # ---------------------------------------------------------------
        emailService = softwareSystem "SendGrid" "Third-party email delivery service that delivers notification emails to users' inboxes." "External System"

        # ---------------------------------------------------------------
        # Relationships
        # ---------------------------------------------------------------
        organiser -> connectSphere "Drafts and submits event requests, tracks their status, and requests changes or cancellation"
        attendee -> connectSphere "Signs up, browses published events, registers, and withdraws"
        coordinator -> connectSphere "Reviews assigned requests, books venues and equipment, and confirms events"
        coordinatorLead -> connectSphere "Monitors coordinator workload, and assigns or reassigns events"
        venueStaff -> connectSphere "Maintains venues and availability, and decides on venue booking requests"
        techStaff -> connectSphere "Maintains equipment, reviews equipment requests, and allocates units"
        safetyOfficer -> connectSphere "Reviews events awaiting a safety check"

        connectSphere -> emailService "Sends notification emails through"
    }

    views {
        systemContext connectSphere "SystemContext" "The seven user groups of ConnectSphere and its external email dependency." {
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
