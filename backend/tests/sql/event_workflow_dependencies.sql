-- Only upstream Supabase infrastructure and unrelated arrangement tables are
-- fixtures. Event tables, functions, constraints and policies use repository SQL.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated;
create table auth.users(id uuid primary key, email text);
create table public.profiles(id uuid primary key, role text, full_name text);
create table public.venues(id uuid primary key, name text, location text, capacity integer);
create table public.venue_bookings(
    booking_id uuid primary key default gen_random_uuid(), event_id uuid,
    session_id uuid, venue_id uuid, status text, cancellation_reason text,
    cancelled_at timestamptz, cancelled_by uuid, start_at timestamptz, end_at timestamptz,
    room_layout text
);
create table public.venue_blocks(id uuid primary key default gen_random_uuid(), booking_id uuid);
create table public.venue_tentative_holds(
    id uuid primary key default gen_random_uuid(), event_id uuid, released_at timestamptz
);
create table public.equipment_requests(
    id uuid primary key default gen_random_uuid(), event_id uuid, session_id uuid, status text
);
create table public.equipment_bookings(id uuid primary key default gen_random_uuid(), request_id uuid);
create table public.equipment_request_items(id uuid primary key default gen_random_uuid(), request_id uuid);
create table public.event_safety_reviews(
    id uuid primary key default gen_random_uuid(), event_id uuid, safety_officer_id uuid,
    decision text, notes text, reason text, created_at timestamptz default now()
);
