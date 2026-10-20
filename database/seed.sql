-- ConnectSphere test data: wipes ALL data (including login accounts) and
-- recreates a clean, known set for manual testing.
--
-- Run in the Supabase SQL Editor. Safe to rerun; every run starts from empty.
-- Event dates are relative to the day it runs (Singapore time), so they stay
-- in the future.
--
-- Every account's password is: password
-- Every email is a "+" alias of maggiemee3103@gmail.com, so all mail lands
-- in that one inbox.

begin;

-- ---------------------------------------------------------------------------
-- 1. Wipe
-- ---------------------------------------------------------------------------

truncate table
    public.equipment_bookings,
    public.equipment_request_items,
    public.equipment_requests,
    public.equipment,
    public.event_activity_logs,
    public.event_change_requests,
    public.event_clarifications,
    public.event_safety_reviews,
    public.safety_change_request_messages,
    public.notifications,
    public.venue_tentative_holds,
    public.venue_blocks,
    public.venue_bookings,
    public.venue_edit_history,
    public.venues,
    public.events,
    public.profiles
cascade;

-- Cascades to auth.identities, sessions and refresh tokens.
delete from auth.users;

-- Singapore wall-clock time, N days from today.
create function pg_temp.sg(days int, hhmm text) returns timestamptz
language sql stable as $$
    select (((now() at time zone 'Asia/Singapore')::date + days) + hhmm::time)
        at time zone 'Asia/Singapore'
$$;

-- ---------------------------------------------------------------------------
-- 2. Accounts (password: password)
-- ---------------------------------------------------------------------------

create temp table seed_accounts (id uuid, email text, full_name text, role text) on commit drop;
insert into seed_accounts values
    ('00000000-0000-4000-a000-000000000001', 'maggiemee3103+organiser@gmail.com',       'Test Organiser',        'organiser'),
    ('00000000-0000-4000-a000-000000000002', 'maggiemee3103+attendee@gmail.com',        'Test Attendee',         'attendee'),
    ('00000000-0000-4000-a000-000000000003', 'maggiemee3103+coordinator@gmail.com',     'Test Coordinator',      'coordinator'),
    ('00000000-0000-4000-a000-000000000004', 'maggiemee3103+coordinator2@gmail.com',    'Test Coordinator 2',    'coordinator'),
    ('00000000-0000-4000-a000-000000000005', 'maggiemee3103+coordinatorlead@gmail.com', 'Test Coordinator Lead', 'event_coordinator_lead'),
    ('00000000-0000-4000-a000-000000000006', 'maggiemee3103+venuestaff@gmail.com',      'Test Venue Staff',      'venue_staff'),
    ('00000000-0000-4000-a000-000000000007', 'maggiemee3103+techsupport@gmail.com',     'Test Tech Support',     'tech_support'),
    ('00000000-0000-4000-a000-000000000008', 'maggiemee3103+safetyofficer@gmail.com',   'Test Safety Officer',   'safety_officer');

insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
    extensions.crypt('password', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"email_verified":true}', now(), now(),
    '', '', '', ''
from seed_accounts;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select id::text, id,
    jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
from seed_accounts;

insert into public.profiles (id, full_name, role, contact_number, organization)
select id, full_name, role,
    case when role = 'organiser' then '91234567' end,
    case when role = 'organiser' then 'ConnectSphere Test Org' end
from seed_accounts;

-- ---------------------------------------------------------------------------
-- 3. Venues and equipment
-- ---------------------------------------------------------------------------

insert into public.venues (id, name, location, capacity, facilities, accessibility, layouts, operating_hours, setup_time_minutes, turnaround_time_minutes) values
    ('00000000-0000-4000-b000-000000000001', 'SCIS Seminar Room 3-1', '80 Stamford Road, Singapore 178902', 120,
        '["Wi-Fi", "Projector"]', '["Wheelchair access"]',
        '[{"name": "Classroom", "capacity": 60}, {"name": "Theatre", "capacity": 120}]',
        '{"open": "08:00", "close": "22:00"}', 30, 30),
    ('00000000-0000-4000-b000-000000000002', 'Hall of Fame Auditorium', '70 Stamford Road, Singapore 178901', 400,
        '["Wi-Fi", "Stage", "PA system"]', '["Wheelchair access", "Hearing loop"]',
        '[{"name": "Theatre", "capacity": 400}, {"name": "Banquet", "capacity": 200}]',
        '{"open": "08:00", "close": "23:00"}', 60, 60),
    ('00000000-0000-4000-b000-000000000003', 'Meeting Room 2-2', '81 Victoria Street, Singapore 188065', 20,
        '["Wi-Fi", "TV screen"]', '[]',
        '[{"name": "Boardroom", "capacity": 12}, {"name": "Classroom", "capacity": 20}]',
        '{"open": "09:00", "close": "18:00"}', 15, 15),
    ('00000000-0000-4000-b000-000000000004', 'Campus Green Lounge', '90 Stamford Road, Singapore 178903', 150,
        '["Wi-Fi"]', '["Wheelchair access"]',
        '[{"name": "Networking", "capacity": 150}, {"name": "Banquet", "capacity": 100}]',
        '{"open": "10:00", "close": "22:00"}', 30, 45);

insert into public.equipment (id, name, type, maintenance_status) values
    ('00000000-0000-4000-c000-000000000001', 'Wireless Microphone', 'Audio',  'Functional'),
    ('00000000-0000-4000-c000-000000000002', 'Wireless Microphone', 'Audio',  'Functional'),
    ('00000000-0000-4000-c000-000000000003', 'Audio Mixer',         'Audio',  'Functional'),
    ('00000000-0000-4000-c000-000000000004', 'Speaker',             'Audio',  'Under Repair'),
    ('00000000-0000-4000-c000-000000000005', 'Projector',           'Visual', 'Functional'),
    ('00000000-0000-4000-c000-000000000006', 'Projector',           'Visual', 'Functional'),
    ('00000000-0000-4000-c000-000000000007', 'Visualiser',          'Visual', 'Functional'),
    ('00000000-0000-4000-c000-000000000008', 'Old Projector',       'Visual', 'Decommissioned');

-- ---------------------------------------------------------------------------
-- 4. Events: one per stage.
--    Organiser: Test Organiser. Coordinator: Test Coordinator unless noted.
-- ---------------------------------------------------------------------------

insert into public.events (id, organiser_id, coordinator_id, name, description, purpose, category, start_time, end_time,
    expected_attendance, location_preference, layout_preference, accessibility_requirements, equipment_requirements, status) values
    ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-a000-000000000001', null,
        'Alumni Sharing Session', 'Alumni share their career journeys.', 'Connect students with alumni.', 'networking',
        pg_temp.sg(40, '18:00'), pg_temp.sg(40, '20:00'), 60, 'Stamford Road', 'Networking', null, null, 'draft'),
    ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-a000-000000000001', null,
        'Cybersecurity Seminar', 'Talks on staying safe online.', 'Raise security awareness.', 'seminar',
        pg_temp.sg(30, '14:00'), pg_temp.sg(30, '16:00'), 80, 'Stamford Road', 'Theatre', null, '1 projector', 'under_review'),
    ('00000000-0000-4000-d000-000000000003', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'AI Ethics Workshop', 'Hands-on discussion of AI ethics cases.', 'Teach responsible AI practice.', 'workshop',
        pg_temp.sg(28, '09:00'), pg_temp.sg(28, '12:00'), 40, 'Stamford Road', 'Classroom', 'Wheelchair access', '1 projector', 'under_review'),
    ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Startup Pitch Night', 'Student startups pitch to investors.', 'Showcase student ventures.', 'networking',
        pg_temp.sg(35, '18:00'), pg_temp.sg(35, '21:00'), 100, 'Stamford Road', 'Networking', null, '2 microphones', 'awaiting_clarification'),
    ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Data Science Bootcamp', 'Full-day introduction to data science.', 'Upskill participants in data analysis.', 'training',
        pg_temp.sg(21, '09:00'), pg_temp.sg(21, '17:00'), 50, 'Stamford Road', 'Classroom', null, '1 microphone, 1 projector', 'planning'),
    ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Product Launch Briefing', 'Briefing on the new product line.', 'Launch the product to partners.', 'product_launch',
        pg_temp.sg(14, '14:00'), pg_temp.sg(14, '16:00'), 100, 'Stamford Road', 'Theatre', null, null, 'planning'),
    ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Annual Tech Conference', 'Keynotes and talks on emerging tech.', 'Bring the tech community together.', 'conference',
        pg_temp.sg(45, '09:00'), pg_temp.sg(45, '17:00'), 300, 'Stamford Road', 'Theatre', 'Wheelchair access, hearing loop', '1 audio mixer, 1 projector', 'awaiting_safety_check'),
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Leadership Seminar', 'Senior leaders share lessons learnt.', 'Develop student leaders.', 'seminar',
        pg_temp.sg(10, '10:00'), pg_temp.sg(10, '12:00'), 50, 'Stamford Road', 'Classroom', null, null, 'confirmed'),
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Charity Gala Dinner', 'Dinner and auction for charity.', 'Raise funds for a local charity.', 'social_event',
        pg_temp.sg(50, '18:00'), pg_temp.sg(50, '22:00'), 180, 'Stamford Road', 'Banquet', null, '2 microphones', 'planning'),
    ('00000000-0000-4000-d000-000000000010', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Marketing Workshop', 'Practical digital marketing skills.', 'Teach social media marketing.', 'workshop',
        pg_temp.sg(25, '13:00'), pg_temp.sg(25, '16:00'), 30, 'Stamford Road', 'Classroom', null, null, 'change_requested'),
    ('00000000-0000-4000-d000-000000000011', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Overnight Hackathon', 'Overnight coding competition.', 'Build prototypes in 12 hours.', 'training',
        pg_temp.sg(20, '20:00'), pg_temp.sg(21, '08:00'), 60, 'Stamford Road', 'Classroom', null, null, 'rejected'),
    ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Orientation Networking Night', 'Welcome evening for new students.', 'Help new students meet each other.', 'networking',
        pg_temp.sg(-7, '18:00'), pg_temp.sg(-7, '21:00'), 120, 'Stamford Road', 'Networking', null, null, 'completed'),
    ('00000000-0000-4000-d000-000000000013', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000004',
        'Design Thinking Workshop', 'Small-group design thinking exercises.', 'Practise human-centred design.', 'workshop',
        pg_temp.sg(18, '10:00'), pg_temp.sg(18, '12:00'), 15, 'Victoria Street', 'Classroom', null, null, 'planning');

-- Clarification the organiser has not answered yet.
insert into public.event_clarifications (event_id, organiser_id, coordinator_id, coordinator_notes, previous_status) values
    ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Please confirm whether food will be served and how many external guests are expected.', 'under_review');

-- Pending change request: attendance going up from 30 to 45.
insert into public.event_change_requests (event_id, organiser_id, event_status_before_request, name, description, purpose, category,
    start_time, end_time, expected_attendance, location_preference, layout_preference, reason_for_change)
select id, organiser_id, 'under_review', name, description, purpose, category, start_time, end_time, 45,
    location_preference, layout_preference, 'More sign-ups than expected.'
from public.events where id = '00000000-0000-4000-d000-000000000010';

-- ---------------------------------------------------------------------------
-- 5. Venue bookings, with calendar blocks for approved ones
-- ---------------------------------------------------------------------------

insert into public.venue_bookings (booking_id, venue_id, coordinator_id, event_id, room_layout, start_at, end_at,
    setup_buffer_minutes, teardown_buffer_minutes, effective_start_at, effective_end_at, status, reviewed_by)
select b.booking_id, b.venue_id, e.coordinator_id, e.id, b.layout, e.start_time, e.end_time,
    v.setup_time_minutes, v.turnaround_time_minutes,
    e.start_time - make_interval(mins => v.setup_time_minutes), e.end_time + make_interval(mins => v.turnaround_time_minutes),
    b.status, case when b.status = 'APPROVED' then '00000000-0000-4000-a000-000000000006'::uuid end
from (values
    ('00000000-0000-4000-e000-000000000006'::uuid, '00000000-0000-4000-d000-000000000006'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Theatre',    'PENDING_VENUE_APPROVAL'),
    ('00000000-0000-4000-e000-000000000007'::uuid, '00000000-0000-4000-d000-000000000007'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'Theatre',    'APPROVED'),
    ('00000000-0000-4000-e000-000000000008'::uuid, '00000000-0000-4000-d000-000000000008'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Classroom',  'APPROVED'),
    ('00000000-0000-4000-e000-000000000009'::uuid, '00000000-0000-4000-d000-000000000009'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'Banquet',    'APPROVED'),
    ('00000000-0000-4000-e000-000000000012'::uuid, '00000000-0000-4000-d000-000000000012'::uuid, '00000000-0000-4000-b000-000000000004'::uuid, 'Networking', 'APPROVED')
) as b(booking_id, event_id, venue_id, layout, status)
join public.events e on e.id = b.event_id
join public.venues v on v.id = b.venue_id;

insert into public.venue_blocks (venue_id, block_reason, start_at, end_at, block_issuer, booking_id, source_booking_id)
select b.venue_id, 'Approved Booking: ' || e.name || ' (' || b.room_layout || ')',
    b.effective_start_at, b.effective_end_at, b.reviewed_by, b.booking_id, b.booking_id
from public.venue_bookings b join public.events e on e.id = b.event_id
where b.status = 'APPROVED';

-- Operational block (maintenance) for the Venue Staff calendar.
insert into public.venue_blocks (venue_id, block_reason, start_at, end_at, block_issuer) values
    ('00000000-0000-4000-b000-000000000003', 'Air-conditioning maintenance',
        pg_temp.sg(7, '09:00'), pg_temp.sg(7, '18:00'), '00000000-0000-4000-a000-000000000006');

-- Active tentative hold for Coordinator 2's event (expires 5 days from now).
insert into public.venue_tentative_holds (venue_id, event_id, start_at, end_at, expires_at, created_by)
select '00000000-0000-4000-b000-000000000003', id, start_time, end_time, pg_temp.sg(5, '17:00'), '00000000-0000-4000-a000-000000000006'
from public.events where id = '00000000-0000-4000-d000-000000000013';

-- ---------------------------------------------------------------------------
-- 6. Equipment requests
-- ---------------------------------------------------------------------------

insert into public.equipment_requests (id, event_id, coordinator_id, status, request_details) values
    ('00000000-0000-4000-f000-000000000005', '00000000-0000-4000-d000-000000000005', '00000000-0000-4000-a000-000000000003',
        'Pending Technical Approval', 'One microphone for the trainer and one projector for slides.'),
    ('00000000-0000-4000-f000-000000000007', '00000000-0000-4000-d000-000000000007', '00000000-0000-4000-a000-000000000003',
        'Approved', 'Audio mixer for the keynote stage and a projector for slides.');

insert into public.equipment_request_items (request_id, equipment_id, quantity) values
    ('00000000-0000-4000-f000-000000000005', '00000000-0000-4000-c000-000000000001', 1),
    ('00000000-0000-4000-f000-000000000005', '00000000-0000-4000-c000-000000000005', 1),
    ('00000000-0000-4000-f000-000000000007', '00000000-0000-4000-c000-000000000003', 1),
    ('00000000-0000-4000-f000-000000000007', '00000000-0000-4000-c000-000000000006', 1);

insert into public.equipment_bookings (equipment_id, request_id, start_at, end_at, created_by)
select i.equipment_id, i.request_id, e.start_time, e.end_time, '00000000-0000-4000-a000-000000000007'
from public.equipment_request_items i
join public.equipment_requests r on r.id = i.request_id
join public.events e on e.id = r.event_id
where r.status = 'Approved';

-- ---------------------------------------------------------------------------
-- 7. Safety reviews
-- ---------------------------------------------------------------------------

insert into public.event_safety_reviews (event_id, safety_officer_id, decision, notes, reason) values
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000008', 'APPROVED', 'All safety requirements met.', null),
    ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-a000-000000000008', 'APPROVED', 'All safety requirements met.', null),
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000008', 'CHANGES_REQUESTED', null,
        'Add a crowd-control plan and assign a second emergency exit marshal.');

insert into public.safety_change_request_messages (event_id, sender_id, message) values
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000008',
        'Please add a crowd-control plan and a second exit marshal, then request the safety check again.');

commit;
