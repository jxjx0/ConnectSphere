-- The tables and helpers the equipment request functions touch, for
-- test_equipment_request_lines_database.py.

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

create function public.is_tech_support()
returns boolean
language sql
stable
as $$
    select auth.uid() = nullif(current_setting('test.tech_id', true), '')::uuid
$$;

create table public.profiles (
    id uuid primary key,
    full_name text
);

create table public.events (
    id uuid primary key,
    organiser_id uuid references public.profiles(id),
    coordinator_id uuid,
    name text,
    status text,
    start_time timestamptz,
    end_time timestamptz
);

create table public.event_sessions (
    id uuid primary key,
    event_id uuid references public.events(id),
    name text,
    start_time timestamptz,
    end_time timestamptz,
    expected_attendance integer,
    equipment_requirements text
);

create table public.equipment (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    type text not null,
    maintenance_status text not null default 'Functional'
);

create table public.equipment_requests (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id),
    session_id uuid references public.event_sessions(id),
    coordinator_id uuid not null,
    status text not null default 'Pending Technical Approval',
    request_details text not null,
    created_at timestamptz not null default now()
);

create table public.equipment_request_items (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null references public.equipment_requests(id) on delete cascade,
    equipment_id uuid not null references public.equipment(id),
    quantity integer not null
);

create table public.equipment_bookings (
    id uuid primary key default gen_random_uuid(),
    equipment_id uuid not null references public.equipment(id),
    request_id uuid not null references public.equipment_requests(id) on delete cascade,
    start_at timestamptz not null,
    end_at timestamptz not null,
    created_by uuid not null
);

create function public.equipment_request_window(p_request_id uuid)
returns table (
    booking_id uuid,
    venue_name text,
    room_layout text,
    start_at timestamptz,
    end_at timestamptz,
    booking_status text
)
language sql
stable
as $$
    select null::uuid, null::text, null::text, session.start_time, session.end_time,
        'SESSION_SCHEDULE'::text
    from public.equipment_requests as request
    join public.event_sessions as session on session.id = request.session_id
    where request.id = p_request_id
$$;
