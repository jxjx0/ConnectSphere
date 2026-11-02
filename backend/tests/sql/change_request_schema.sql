-- The tables and helpers the change request functions touch, for
-- test_change_request_database.py.

create schema auth;

create function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create function public.is_coordinator()
returns boolean
language sql
stable
as $$
    select auth.uid() = nullif(current_setting('test.coordinator_id', true), '')::uuid
$$;

create function public.is_organiser()
returns boolean
language sql
stable
as $$
    select auth.uid() = nullif(current_setting('test.organiser_id', true), '')::uuid
$$;

create table public.events (
    id uuid primary key,
    organiser_id uuid not null,
    coordinator_id uuid,
    name text not null,
    description text,
    purpose text,
    category text,
    category_other text,
    accessibility_requirements text,
    status text not null,
    updated_at timestamptz not null default now()
);

create table public.event_sessions (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    name text not null,
    start_time timestamptz not null,
    end_time timestamptz not null,
    expected_attendance integer not null,
    location_preference text,
    layout_preference text,
    equipment_requirements text
);

create table public.event_change_requests (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    organiser_id uuid not null,
    name text not null,
    description text,
    reason_for_change text,
    purpose text,
    category text,
    category_other text,
    accessibility_requirements text,
    start_time timestamptz,
    end_time timestamptz,
    expected_attendance integer,
    status text not null default 'pending',
    closed_at timestamptz,
    closed_by uuid,
    decision_reason text
);

create table public.event_change_request_sessions (
    id uuid primary key default gen_random_uuid(),
    change_request_id uuid not null references public.event_change_requests(id) on delete cascade,
    session_id uuid,
    name text not null,
    start_time timestamptz not null,
    end_time timestamptz not null,
    expected_attendance integer not null,
    location_preference text,
    layout_preference text,
    equipment_requirements text
);

create table public.event_cancellation_requests (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    status text not null default 'pending'
);

create table public.event_clarifications (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    status text not null default 'pending'
);

create table public.venues (
    id uuid primary key default gen_random_uuid(),
    name text
);

create table public.venue_bookings (
    booking_id uuid primary key default gen_random_uuid(),
    venue_id uuid references public.venues(id),
    session_id uuid,
    status text not null,
    cancellation_reason text,
    cancelled_at timestamptz,
    cancelled_by uuid
);

create table public.equipment_requests (
    id uuid primary key default gen_random_uuid(),
    session_id uuid,
    status text not null
);
