-- 1. Create venue_bookings table
CREATE TABLE venue_bookings (
    booking_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    coordinator_id UUID NOT NULL REFERENCES profiles(id),
    event_id UUID NULL,
    room_layout VARCHAR(100) NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    setup_buffer_minutes INT NOT NULL DEFAULT 0,
    teardown_buffer_minutes INT NOT NULL DEFAULT 0,
    effective_start_at TIMESTAMPTZ NOT NULL,
    effective_end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_VENUE_APPROVAL',
    rejection_reason TEXT NULL,
    reviewed_by UUID NULL REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE venue_bookings ENABLE ROW LEVEL SECURITY;

-- Policy A: Event Coordinators can read their own submitted bookings
CREATE POLICY coordinator_select_own_bookings ON venue_bookings
    FOR SELECT TO authenticated
    USING (auth.uid() = coordinator_id);

-- Policy B: Event Coordinators can insert booking requests under their account
CREATE POLICY coordinator_insert_own_bookings ON venue_bookings
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = coordinator_id);

-- Policy C: Venue Staff can view and manage all booking requests
CREATE POLICY staff_manage_all_bookings ON venue_bookings
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() AND role = 'venue_staff'
        )
    );