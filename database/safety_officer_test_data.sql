-- =============================================================================
-- TEST DATA MANAGEMENT FOR SAFETY OFFICER FLOW
-- Creates 3 Pending Events for Interactive Safety Officer Testing:
--   1. Clean Event (No flags) -> Ready to test "APPROVE"
--   2. Capacity Hazard Flag -> Ready to test "REQUEST CHANGES"
--   3. Operating Hours & Crowd Flag -> Ready to test "REJECT"
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SECTION 1: CLEANUP / DELETE TEST DATA
-- -----------------------------------------------------------------------------
BEGIN;

-- 1. Delete Safety Officer Reviews and Messages
DELETE FROM safety_change_request_messages WHERE event_id IN (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202',
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303'
);
DELETE FROM event_safety_reviews WHERE event_id IN (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202',
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303'
);

-- 2. Delete Equipment Bookings, Items, and Requests
DELETE FROM equipment_bookings WHERE request_id IN (
  'e6c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 
  'f7d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
  'd8e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a'
);
DELETE FROM equipment_request_items WHERE request_id IN (
  'e6c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 
  'f7d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
  'd8e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a'
);
DELETE FROM equipment_requests WHERE event_id IN (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202',
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303'
);

-- 3. Delete Venue Blocks & Bookings
DELETE FROM venue_blocks WHERE booking_id IN (
  'c4a1b2c3-d4e5-4f6a-8b7c-9d0e1f2a3b4c', 
  'd5b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  'e6c3d4e5-f7a8-4b9c-0d1e-2f3a4b5c6d7e'
);
DELETE FROM venue_bookings WHERE event_id IN (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202',
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303'
);

-- 4. Delete Events, Equipment, and Venues
DELETE FROM events WHERE id IN (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202',
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303'
);
DELETE FROM equipment WHERE id IN ('f1a2b3c4-d5e6-7a8b-9c0d-1e2f3a4b5c6d', 'e9d8c7b6-a5f4-3e2d-1c0b-9a8f7e6d5c4b');
DELETE FROM venues WHERE id = '8e2d4a10-3c9f-4b12-a7d5-1f8e9c2b3d4a';

COMMIT;


-- -----------------------------------------------------------------------------
-- SECTION 2: INSERT TEST FIXTURES
-- -----------------------------------------------------------------------------
BEGIN;

-- 1. Venues & Technical Equipment
INSERT INTO venues (
  id, name, location, capacity, layouts, operating_hours, accessibility, setup_time_minutes, turnaround_time_minutes
) VALUES (
  '8e2d4a10-3c9f-4b12-a7d5-1f8e9c2b3d4a', 
  'Test Grand Hall', 
  'Building A, Level 2', 
  300, 
  '[{"name": "Banquet", "capacity": 200}, {"name": "Theater", "capacity": 300}]'::jsonb,
  '{"open": "08:00", "close": "22:00"}'::jsonb,
  '["Wheelchair Ramp", "Accessible Restroom"]'::jsonb, 
  30, 
  30
) ON CONFLICT (id) DO NOTHING;

INSERT INTO equipment (id, name, type, maintenance_status) VALUES
  ('f1a2b3c4-d5e6-7a8b-9c0d-1e2f3a4b5c6d', 'PA System 500W', 'Audio', 'Functional'),
  ('e9d8c7b6-a5f4-3e2d-1c0b-9a8f7e6d5c4b', 'Stage Spotlight Kit', 'Lighting', 'Functional')
ON CONFLICT (id) DO NOTHING;


-- 2. Pending Events for Interactive Safety Officer Review

-- EVENT 1: Clean Schedule & Capacity -> Test "APPROVE"
-- Expected: 0 Flags -> Click "Approve Event"
INSERT INTO events (
  id, name, category, organiser_id, coordinator_id, start_time, end_time, 
  expected_attendance, description, purpose, layout_preference, status, safety_status
) VALUES (
  'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 
  'Test Event 1 - Ready for Approval', 
  'workshop', 
  '4ab9efa1-0a60-479a-b1fd-e1cd33b46115', -- Jing Xiang (Organiser)
  '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', -- Megan (Coordinator)
  '2026-11-15 10:00:00+00', 
  '2026-11-15 12:00:00+00', 
  150, 
  'Standard workshop meeting.', 
  'Test scenario for Safety Officer APPROVE decision.', 
  'Theater', 
  'awaiting_safety_check', 
  'pending'
) ON CONFLICT (id) DO NOTHING;

-- EVENT 2: Attendance (400) > Banquet Capacity (200) -> Test "REQUEST CHANGES"
-- Expected: Trigger [CAPACITY_EXCEEDED] Flag -> Click "Request Changes"
INSERT INTO events (
  id, name, category, organiser_id, coordinator_id, start_time, end_time, 
  expected_attendance, description, purpose, layout_preference, status, safety_status
) VALUES (
  'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202', 
  'Test Event 2 - Capacity Hazard Flag', 
  'ceremony', 
  '4ab9efa1-0a60-479a-b1fd-e1cd33b46115', -- Jing Xiang (Organiser)
  '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', -- Megan (Coordinator)
  '2026-11-16 18:00:00+00', 
  '2026-11-16 21:00:00+00', 
  400, 
  'Gala event with attendance exceeding capacity.', 
  'Test scenario for Safety Officer REQUEST CHANGES decision.', 
  'Banquet', 
  'awaiting_safety_check', 
  'pending'
) ON CONFLICT (id) DO NOTHING;

-- EVENT 3: Night Schedule (23:00 - 02:00) & Large Crowd (600) -> Test "REJECT"
-- Expected: Trigger [OPERATING_HOURS_VIOLATION] & [LARGE_CROWD_PROTOCOL] Flags -> Click "Reject Event"
INSERT INTO events (
  id, name, category, organiser_id, coordinator_id, start_time, end_time, 
  expected_attendance, description, purpose, layout_preference, status, safety_status
) VALUES (
  'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303', 
  'Test Event 3 - Overtime & Extreme Hazard', 
  'social_event', 
  '4ab9efa1-0a60-479a-b1fd-e1cd33b46115', -- Jing Xiang (Organiser)
  '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', -- Megan (Coordinator)
  '2026-11-17 23:00:00+00', 
  '2026-11-18 02:00:00+00', 
  600, 
  'Overnight concert event violating operating hours.', 
  'Test scenario for Safety Officer REJECT decision.', 
  'Theater', 
  'awaiting_safety_check', 
  'pending'
) ON CONFLICT (id) DO NOTHING;


-- 3. Venue Bookings
INSERT INTO venue_bookings (
  booking_id, venue_id, coordinator_id, event_id, room_layout, start_at, end_at, 
  setup_buffer_minutes, teardown_buffer_minutes, effective_start_at, effective_end_at, status
) VALUES 
  ('c4a1b2c3-d4e5-4f6a-8b7c-9d0e1f2a3b4c', '8e2d4a10-3c9f-4b12-a7d5-1f8e9c2b3d4a', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', 'Theater', '2026-11-15 10:00:00+00', '2026-11-15 12:00:00+00', 30, 30, '2026-11-15 09:30:00+00', '2026-11-15 12:30:00+00', 'CONFIRMED'),
  ('d5b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', '8e2d4a10-3c9f-4b12-a7d5-1f8e9c2b3d4a', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202', 'Banquet', '2026-11-16 18:00:00+00', '2026-11-16 21:00:00+00', 30, 30, '2026-11-16 17:30:00+00', '2026-11-16 21:30:00+00', 'CONFIRMED'),
  ('e6c3d4e5-f7a8-4b9c-0d1e-2f3a4b5c6d7e', '8e2d4a10-3c9f-4b12-a7d5-1f8e9c2b3d4a', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303', 'Theater', '2026-11-17 23:00:00+00', '2026-11-18 02:00:00+00', 30, 30, '2026-11-17 22:30:00+00', '2026-11-18 02:30:00+00', 'CONFIRMED')
ON CONFLICT (booking_id) DO NOTHING;


-- 4. Equipment Requests & Request Items
INSERT INTO equipment_requests (id, event_id, coordinator_id, status) VALUES
  ('e6c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'a3f8c120-5d6b-4e89-9a21-7b0e2c4d6101', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'Approved'),
  ('f7d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', 'b7d9e231-6f7c-4a90-8b32-8c1f3d5e7202', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'Approved'),
  ('d8e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a', 'c8e0f342-7a8b-4c01-9d23-9d2e4f6a8303', '9ec52d44-fcee-45ec-a252-4b1ad5b03d61', 'Approved')
ON CONFLICT (id) DO NOTHING;

INSERT INTO equipment_request_items (id, request_id, equipment_id, quantity) VALUES
  ('1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', 'e6c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'f1a2b3c4-d5e6-7a8b-9c0d-1e2f3a4b5c6d', 2),
  ('2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e', 'f7d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', 'e9d8c7b6-a5f4-3e2d-1c0b-9a8f7e6d5c4b', 1)
ON CONFLICT (id) DO NOTHING;

COMMIT;