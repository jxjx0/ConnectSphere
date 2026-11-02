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
    public.equipment_request_lines,
    public.equipment_requests,
    public.equipment,
    public.event_activity_logs,
    public.event_cancellation_requests,
    public.event_change_request_sessions,
    public.event_change_requests,
    public.event_clarifications,
    public.event_registrations,
    public.event_safety_reviews,
    public.safety_change_request_messages,
    public.notifications,
    public.venue_tentative_holds,
    public.venue_blocks,
    public.venue_bookings,
    public.venue_edit_history,
    public.venues,
    public.event_sessions,
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

-- The type is the kind of item Coordinators ask for, so an Old Projector
-- still counts as a Projector.
insert into public.equipment (id, name, type, maintenance_status) values
    ('00000000-0000-4000-c000-000000000001', 'Wireless Microphone', 'Wireless Microphone', 'Functional'),
    ('00000000-0000-4000-c000-000000000002', 'Wireless Microphone', 'Wireless Microphone', 'Functional'),
    ('00000000-0000-4000-c000-000000000003', 'Audio Mixer',         'Audio Mixer',         'Functional'),
    ('00000000-0000-4000-c000-000000000004', 'Speaker',             'Speaker',             'Under Repair'),
    ('00000000-0000-4000-c000-000000000005', 'Projector',           'Projector',           'Functional'),
    ('00000000-0000-4000-c000-000000000006', 'Projector',           'Projector',           'Functional'),
    ('00000000-0000-4000-c000-000000000007', 'Visualiser',          'Visualiser',          'Functional'),
    ('00000000-0000-4000-c000-000000000008', 'Old Projector',       'Projector',           'Decommissioned');

-- ---------------------------------------------------------------------------
-- 4. Events: one per stage, each made of sessions.
--    Organiser: Test Organiser. Coordinator: Test Coordinator unless noted.
--    Open clarifications, change and cancellation requests sit on top of the
--    stage rather than replacing it, so they are rows of their own below.
--    Time, attendance, location, layout and equipment belong to each session
--    (scope doc 9.1). The event's start, end and attendance are kept in step
--    with its sessions by the database; the values here are just their span.
-- ---------------------------------------------------------------------------

insert into public.events (id, organiser_id, coordinator_id, name, description, purpose, category, start_time, end_time,
    expected_attendance, accessibility_requirements, status) values
    ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-a000-000000000001', null,
        'Alumni Sharing Session', 'Alumni share their career journeys.', 'Connect students with alumni.', 'networking',
        pg_temp.sg(40, '18:00'), pg_temp.sg(40, '20:00'), 60, null, 'draft'),
    ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-a000-000000000001', null,
        'Cybersecurity Seminar', 'Talks on staying safe online.', 'Raise security awareness.', 'seminar',
        pg_temp.sg(30, '14:00'), pg_temp.sg(30, '16:00'), 80, null, 'under_review'),
    ('00000000-0000-4000-d000-000000000003', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'AI Ethics Workshop', 'Hands-on discussion of AI ethics cases.', 'Teach responsible AI practice.', 'workshop',
        pg_temp.sg(28, '09:00'), pg_temp.sg(28, '15:00'), 40, 'Wheelchair access', 'under_review'),
    ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Startup Pitch Night', 'Student startups pitch to investors.', 'Showcase student ventures.', 'networking',
        pg_temp.sg(35, '18:00'), pg_temp.sg(35, '21:00'), 100, null, 'under_review'),
    ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Data Science Bootcamp', 'Full-day introduction to data science.', 'Upskill participants in data analysis.', 'training',
        pg_temp.sg(21, '09:00'), pg_temp.sg(21, '17:00'), 50, null, 'planning'),
    ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Product Launch Briefing', 'Briefing on the new product line.', 'Launch the product to partners.', 'product_launch',
        pg_temp.sg(14, '14:00'), pg_temp.sg(14, '16:00'), 100, null, 'planning'),
    ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Annual Tech Conference', 'Keynotes and talks on emerging tech.', 'Bring the tech community together.', 'conference',
        pg_temp.sg(45, '09:00'), pg_temp.sg(45, '17:00'), 300, 'Wheelchair access, hearing loop', 'awaiting_safety_check'),
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Leadership Seminar', 'Senior leaders share lessons learnt.', 'Develop student leaders.', 'seminar',
        pg_temp.sg(10, '10:00'), pg_temp.sg(10, '12:00'), 50, null, 'confirmed'),
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Charity Gala Dinner', 'Dinner and auction for charity.', 'Raise funds for a local charity.', 'social_event',
        pg_temp.sg(50, '18:00'), pg_temp.sg(50, '22:00'), 180, null, 'planning'),
    ('00000000-0000-4000-d000-000000000010', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Marketing Workshop', 'Practical digital marketing skills.', 'Teach social media marketing.', 'workshop',
        pg_temp.sg(25, '13:00'), pg_temp.sg(25, '16:00'), 30, null, 'planning'),
    ('00000000-0000-4000-d000-000000000011', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Overnight Hackathon', 'Overnight coding competition.', 'Build prototypes in 12 hours.', 'training',
        pg_temp.sg(20, '20:00'), pg_temp.sg(21, '08:00'), 60, null, 'rejected'),
    ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Orientation Networking Night', 'Welcome evening for new students.', 'Help new students meet each other.', 'networking',
        pg_temp.sg(-7, '18:00'), pg_temp.sg(-7, '21:00'), 120, null, 'completed'),
    ('00000000-0000-4000-d000-000000000013', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000004',
        'Design Thinking Workshop', 'Small-group design thinking exercises.', 'Practise human-centred design.', 'workshop',
        pg_temp.sg(18, '10:00'), pg_temp.sg(18, '12:00'), 15, null, 'planning'),
    -- Confirmed, but registration is not set up yet.
    ('00000000-0000-4000-d000-000000000014', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Photography Walk', 'Guided photo walk around the civic district.', 'Teach street photography basics.', 'workshop',
        pg_temp.sg(32, '09:00'), pg_temp.sg(32, '12:00'), 40, null, 'confirmed'),
    -- Cancelled while it was waiting for its safety check.
    ('00000000-0000-4000-d000-000000000015', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Robotics Showcase', 'Student robotics teams demo their builds.', 'Show off student engineering projects.', 'conference',
        pg_temp.sg(26, '10:00'), pg_temp.sg(26, '16:00'), 150, null, 'cancelled');

-- Registration is published for Leadership Seminar only.
update public.events
set registration_opens_at = pg_temp.sg(-5, '09:00'),
    registration_closes_at = pg_temp.sg(9, '23:59'),
    attendee_capacity = 50,
    published_at = now()
where id = '00000000-0000-4000-d000-000000000008';

-- When each reached the Safety Officer's queue. Only status changes set this,
-- so seeded rows need it set directly.
update public.events set safety_check_requested_at = now() - interval '2 days'
where id = '00000000-0000-4000-d000-000000000007';
update public.events set safety_check_requested_at = now() - interval '6 days'
where id = '00000000-0000-4000-d000-000000000015';

-- Session ids end in the event number and the session number: ...0000000071
-- is event 07's first session.
insert into public.event_sessions (id, event_id, name, start_time, end_time, expected_attendance,
    location_preference, layout_preference, equipment_requirements) values
    -- Draft: the second session is only half filled in.
    ('00000000-0000-4000-9000-000000000011', '00000000-0000-4000-d000-000000000001', 'Main session',
        pg_temp.sg(40, '18:00'), pg_temp.sg(40, '20:00'), 60, 'Stamford Road', 'Networking', null),
    ('00000000-0000-4000-9000-000000000012', '00000000-0000-4000-d000-000000000001', 'Breakout', null, null, null, null, null, null),
    ('00000000-0000-4000-9000-000000000021', '00000000-0000-4000-d000-000000000002', 'Main session',
        pg_temp.sg(30, '14:00'), pg_temp.sg(30, '16:00'), 80, 'Stamford Road', 'Theatre', '1 projector'),
    ('00000000-0000-4000-9000-000000000031', '00000000-0000-4000-d000-000000000003', 'Morning discussion',
        pg_temp.sg(28, '09:00'), pg_temp.sg(28, '12:00'), 40, 'Stamford Road', 'Classroom', '1 projector'),
    ('00000000-0000-4000-9000-000000000032', '00000000-0000-4000-d000-000000000003', 'Case studies',
        pg_temp.sg(28, '13:00'), pg_temp.sg(28, '15:00'), 40, 'Stamford Road', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000041', '00000000-0000-4000-d000-000000000004', 'Pitches',
        pg_temp.sg(35, '18:00'), pg_temp.sg(35, '20:00'), 100, 'Stamford Road', 'Networking', '2 microphones'),
    ('00000000-0000-4000-9000-000000000042', '00000000-0000-4000-d000-000000000004', 'Networking',
        pg_temp.sg(35, '20:00'), pg_temp.sg(35, '21:00'), 100, 'Stamford Road', 'Networking', null),
    ('00000000-0000-4000-9000-000000000051', '00000000-0000-4000-d000-000000000005', 'Morning lecture',
        pg_temp.sg(21, '09:00'), pg_temp.sg(21, '12:00'), 50, 'Stamford Road', 'Classroom', '1 microphone, 1 projector'),
    ('00000000-0000-4000-9000-000000000052', '00000000-0000-4000-d000-000000000005', 'Afternoon lab',
        pg_temp.sg(21, '13:00'), pg_temp.sg(21, '17:00'), 50, 'Stamford Road', 'Classroom', '1 projector'),
    ('00000000-0000-4000-9000-000000000061', '00000000-0000-4000-d000-000000000006', 'Main session',
        pg_temp.sg(14, '14:00'), pg_temp.sg(14, '16:00'), 100, 'Stamford Road', 'Theatre', null),
    -- Parallel spaces: two breakouts run alongside the afternoon keynote.
    ('00000000-0000-4000-9000-000000000071', '00000000-0000-4000-d000-000000000007', 'Main programme',
        pg_temp.sg(45, '09:00'), pg_temp.sg(45, '17:00'), 300, 'Stamford Road', 'Theatre', '1 audio mixer, 1 projector'),
    ('00000000-0000-4000-9000-000000000072', '00000000-0000-4000-d000-000000000007', 'Breakout A',
        pg_temp.sg(45, '13:00'), pg_temp.sg(45, '17:00'), 50, 'Stamford Road', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000073', '00000000-0000-4000-d000-000000000007', 'Breakout B',
        pg_temp.sg(45, '13:00'), pg_temp.sg(45, '17:00'), 50, 'Stamford Road', 'Networking', null),
    ('00000000-0000-4000-9000-000000000081', '00000000-0000-4000-d000-000000000008', 'Main session',
        pg_temp.sg(10, '10:00'), pg_temp.sg(10, '12:00'), 50, 'Stamford Road', 'Classroom', null),
    -- Back to back in two venues.
    ('00000000-0000-4000-9000-000000000091', '00000000-0000-4000-d000-000000000009', 'Reception',
        pg_temp.sg(50, '18:00'), pg_temp.sg(50, '19:00'), 150, 'Stamford Road', 'Networking', null),
    ('00000000-0000-4000-9000-000000000092', '00000000-0000-4000-d000-000000000009', 'Dinner and auction',
        pg_temp.sg(50, '19:00'), pg_temp.sg(50, '22:00'), 180, 'Stamford Road', 'Banquet', '2 microphones'),
    ('00000000-0000-4000-9000-000000000101', '00000000-0000-4000-d000-000000000010', 'Main session',
        pg_temp.sg(25, '13:00'), pg_temp.sg(25, '16:00'), 30, 'Stamford Road', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000111', '00000000-0000-4000-d000-000000000011', 'Hackathon',
        pg_temp.sg(20, '20:00'), pg_temp.sg(21, '08:00'), 60, 'Stamford Road', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000121', '00000000-0000-4000-d000-000000000012', 'Main session',
        pg_temp.sg(-7, '18:00'), pg_temp.sg(-7, '21:00'), 120, 'Stamford Road', 'Networking', null),
    ('00000000-0000-4000-9000-000000000131', '00000000-0000-4000-d000-000000000013', 'Main session',
        pg_temp.sg(18, '10:00'), pg_temp.sg(18, '12:00'), 15, 'Victoria Street', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000141', '00000000-0000-4000-d000-000000000014', 'Photo walk',
        pg_temp.sg(32, '09:00'), pg_temp.sg(32, '12:00'), 40, 'Stamford Road', 'Classroom', null),
    ('00000000-0000-4000-9000-000000000151', '00000000-0000-4000-d000-000000000015', 'Showcase',
        pg_temp.sg(26, '10:00'), pg_temp.sg(26, '16:00'), 150, 'Stamford Road', 'Networking', null);

-- Clarification the organiser has not answered yet.
insert into public.event_clarifications (event_id, organiser_id, coordinator_id, coordinator_notes) values
    ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
        'Please confirm whether food will be served and how many external guests are expected.');

-- Pending change request: the session's attendance going up from 30 to 45.
insert into public.event_change_requests (id, event_id, organiser_id, name, description, purpose, category,
    start_time, end_time, expected_attendance, reason_for_change)
select '00000000-0000-4000-8000-000000000010', id, organiser_id, name, description, purpose, category,
    start_time, end_time, 45, 'More sign-ups than expected.'
from public.events where id = '00000000-0000-4000-d000-000000000010';

insert into public.event_change_request_sessions (change_request_id, session_id, name, start_time, end_time,
    expected_attendance, location_preference, layout_preference, equipment_requirements)
select '00000000-0000-4000-8000-000000000010', id, name, start_time, end_time, 45,
    location_preference, layout_preference, equipment_requirements
from public.event_sessions where id = '00000000-0000-4000-9000-000000000101';

-- Pending cancellation request, and the approved one that cancelled Robotics
-- Showcase while it waited for its safety check.
insert into public.event_cancellation_requests (event_id, organiser_id, reason, status, decision_reason, closed_by, closed_at) values
    ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-a000-000000000001',
        'The product launch has been moved to next quarter.', 'pending', null, null, null),
    ('00000000-0000-4000-d000-000000000015', '00000000-0000-4000-a000-000000000001',
        'Not enough teams signed up to run the showcase.', 'approved',
        'Agreed, cancelling the event.', '00000000-0000-4000-a000-000000000003', now() - interval '1 day');

-- ---------------------------------------------------------------------------
-- 5. Venue bookings, one per session, with calendar blocks for approved ones
-- ---------------------------------------------------------------------------

insert into public.venue_bookings (booking_id, venue_id, coordinator_id, event_id, session_id, room_layout, start_at, end_at,
    setup_buffer_minutes, teardown_buffer_minutes, effective_start_at, effective_end_at, status, reviewed_by)
select b.booking_id, b.venue_id, e.coordinator_id, e.id, s.id, b.layout, s.start_time, s.end_time,
    v.setup_time_minutes, v.turnaround_time_minutes,
    s.start_time - make_interval(mins => v.setup_time_minutes), s.end_time + make_interval(mins => v.turnaround_time_minutes),
    b.status, case when b.status = 'APPROVED' then '00000000-0000-4000-a000-000000000006'::uuid end
from (values
    ('00000000-0000-4000-e000-000000000061'::uuid, '00000000-0000-4000-9000-000000000061'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Theatre',    'PENDING_VENUE_APPROVAL'),
    ('00000000-0000-4000-e000-000000000071'::uuid, '00000000-0000-4000-9000-000000000071'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'Theatre',    'APPROVED'),
    ('00000000-0000-4000-e000-000000000072'::uuid, '00000000-0000-4000-9000-000000000072'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Classroom',  'APPROVED'),
    ('00000000-0000-4000-e000-000000000073'::uuid, '00000000-0000-4000-9000-000000000073'::uuid, '00000000-0000-4000-b000-000000000004'::uuid, 'Networking', 'APPROVED'),
    ('00000000-0000-4000-e000-000000000081'::uuid, '00000000-0000-4000-9000-000000000081'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Classroom',  'APPROVED'),
    ('00000000-0000-4000-e000-000000000091'::uuid, '00000000-0000-4000-9000-000000000091'::uuid, '00000000-0000-4000-b000-000000000004'::uuid, 'Networking', 'APPROVED'),
    ('00000000-0000-4000-e000-000000000092'::uuid, '00000000-0000-4000-9000-000000000092'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'Banquet',    'APPROVED'),
    ('00000000-0000-4000-e000-000000000121'::uuid, '00000000-0000-4000-9000-000000000121'::uuid, '00000000-0000-4000-b000-000000000004'::uuid, 'Networking', 'APPROVED'),
    ('00000000-0000-4000-e000-000000000141'::uuid, '00000000-0000-4000-9000-000000000141'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'Classroom',  'APPROVED'),
    ('00000000-0000-4000-e000-000000000151'::uuid, '00000000-0000-4000-9000-000000000151'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'Theatre',    'CANCELLED')
) as b(booking_id, session_id, venue_id, layout, status)
join public.event_sessions s on s.id = b.session_id
join public.events e on e.id = s.event_id
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
-- Holds stay linked to the event, not a session.
insert into public.venue_tentative_holds (venue_id, event_id, start_at, end_at, expires_at, created_by)
select '00000000-0000-4000-b000-000000000003', id, start_time, end_time, pg_temp.sg(5, '17:00'), '00000000-0000-4000-a000-000000000006'
from public.events where id = '00000000-0000-4000-d000-000000000013';

-- ---------------------------------------------------------------------------
-- 6. Equipment requests, one per session, booked for the session's own time
--    Each request lists how many of each type it needs. A line's name matches
--    equipment.type, or names something not in the catalogue ("Other").
-- ---------------------------------------------------------------------------

insert into public.equipment_requests (id, event_id, session_id, coordinator_id, status, request_details) values
    ('00000000-0000-4000-f000-000000000051', '00000000-0000-4000-d000-000000000005', '00000000-0000-4000-9000-000000000051',
        '00000000-0000-4000-a000-000000000003', 'Pending Technical Approval', 'One microphone for the trainer and one projector for slides.'),
    ('00000000-0000-4000-f000-000000000071', '00000000-0000-4000-d000-000000000007', '00000000-0000-4000-9000-000000000071',
        '00000000-0000-4000-a000-000000000003', 'Approved', 'Audio mixer for the keynote stage and a projector for slides.');

-- Line ids end in the request's session number and the line number.
insert into public.equipment_request_lines (id, request_id, item_name, quantity, specifics) values
    ('00000000-0000-4000-7000-000000000511', '00000000-0000-4000-f000-000000000051', 'Wireless Microphone', 1, 'For the trainer'),
    ('00000000-0000-4000-7000-000000000512', '00000000-0000-4000-f000-000000000051', 'Projector',           1, 'Must have an HDMI input'),
    ('00000000-0000-4000-7000-000000000513', '00000000-0000-4000-f000-000000000051', 'Laser pointer',       1, null),
    ('00000000-0000-4000-7000-000000000711', '00000000-0000-4000-f000-000000000071', 'Audio Mixer',         1, null),
    ('00000000-0000-4000-7000-000000000712', '00000000-0000-4000-f000-000000000071', 'Projector',           1, null);

-- The approved request is fully allocated; the pending one has its projector
-- so far, leaving the microphone and the laser pointer ("Other") to do.
insert into public.equipment_bookings (equipment_id, request_id, line_id, start_at, end_at, created_by)
select b.equipment_id, l.request_id, l.id, s.start_time, s.end_time, '00000000-0000-4000-a000-000000000007'
from (values
    ('00000000-0000-4000-7000-000000000512'::uuid, '00000000-0000-4000-c000-000000000005'::uuid),
    ('00000000-0000-4000-7000-000000000711'::uuid, '00000000-0000-4000-c000-000000000003'::uuid),
    ('00000000-0000-4000-7000-000000000712'::uuid, '00000000-0000-4000-c000-000000000006'::uuid)
) as b(line_id, equipment_id)
join public.equipment_request_lines l on l.id = b.line_id
join public.equipment_requests r on r.id = l.request_id
join public.event_sessions s on s.id = r.session_id;

-- ---------------------------------------------------------------------------
-- 7. Safety reviews
-- ---------------------------------------------------------------------------

insert into public.event_safety_reviews (event_id, safety_officer_id, decision, notes, reason) values
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000008', 'APPROVED', 'All safety requirements met.', null),
    ('00000000-0000-4000-d000-000000000014', '00000000-0000-4000-a000-000000000008', 'APPROVED', 'All safety requirements met.', null),
    ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-a000-000000000008', 'APPROVED', 'All safety requirements met.', null),
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000008', 'CHANGES_REQUESTED', null,
        'Add a crowd-control plan and assign a second emergency exit marshal.');

insert into public.safety_change_request_messages (event_id, sender_id, message) values
    ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-a000-000000000008',
        'Please add a crowd-control plan and a second exit marshal, then request the safety check again.');

-- ---------------------------------------------------------------------------
-- 8. Attendee registrations
--    Leadership Seminar: withdrawn once, then registered again, so it shows
--    once under Upcoming. Orientation Networking Night has ended (Past).
-- ---------------------------------------------------------------------------

insert into public.event_registrations (event_id, attendee_id, full_name, email, address, contact_number,
    created_at, status, withdrawn_at) values
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000002', 'Test Attendee',
        'maggiemee3103+attendee@gmail.com', '80 Stamford Road, Singapore 178902', '98765432',
        now() - interval '4 days', 'withdrawn', now() - interval '3 days'),
    ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-a000-000000000002', 'Test Attendee',
        'maggiemee3103+attendee@gmail.com', '80 Stamford Road, Singapore 178902', '98765432',
        now() - interval '2 days', 'registered', null),
    ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-a000-000000000002', 'Test Attendee',
        'maggiemee3103+attendee@gmail.com', '80 Stamford Road, Singapore 178902', '98765432',
        pg_temp.sg(-14, '12:00'), 'registered', null);

commit;
