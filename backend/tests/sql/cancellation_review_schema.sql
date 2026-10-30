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

create table public.profiles (
    id uuid primary key
);

create table public.events (
    id uuid primary key,
    organiser_id uuid not null references public.profiles(id),
    coordinator_id uuid references public.profiles(id),
    name text not null,
    status text not null,
    start_time timestamptz,
    updated_at timestamptz not null default now(),
    registration_opens_at timestamptz,
    registration_closes_at timestamptz,
    attendee_capacity integer,
    published_at timestamptz
);

create table public.venue_bookings (
    booking_id uuid primary key,
    event_id uuid not null references public.events(id),
    session_id uuid,
    venue_id uuid,
    status text not null
);

create table public.venues (
    id uuid primary key,
    name text,
    location text,
    capacity integer
);

create table public.event_sessions (
    id uuid primary key,
    event_id uuid not null references public.events(id)
);

create table public.venue_blocks (
    id bigserial primary key
);

create table public.venue_tentative_holds (
    id bigserial primary key,
    event_id uuid not null references public.events(id),
    released_at timestamptz
);

create table public.equipment_requests (
    id uuid primary key,
    event_id uuid not null references public.events(id),
    session_id uuid,
    status text not null
);

create table public.equipment_bookings (
    id bigserial primary key,
    request_id uuid not null references public.equipment_requests(id)
);

create table public.event_change_requests (
    id uuid primary key,
    event_id uuid not null references public.events(id),
    status text not null,
    reviewed_at timestamptz,
    rejection_reason text
);

create table public.event_safety_reviews (
    id bigserial primary key,
    event_id uuid not null references public.events(id),
    safety_officer_id uuid,
    decision text not null,
    notes text,
    reason text,
    created_at timestamptz not null default now()
);

create table public.event_registrations (
    id bigserial primary key,
    event_id uuid not null references public.events(id),
    attendee_id uuid,
    email text
);
