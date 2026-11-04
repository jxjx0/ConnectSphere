-- Reconstructed from deployed PostgreSQL catalog metadata on 2026-11-04.
-- Apply as postgres after event_sessions.sql and event_change_requests.sql,
-- before event_status_badges.sql and change_request_in_safety_check.sql.
-- The shared database already contains this table; this file restores the
-- missing clean-install dependency and must not be reapplied there blindly.
begin;

create table public.event_change_request_sessions (
    id uuid not null default gen_random_uuid(),
    change_request_id uuid not null,
    session_id uuid,
    name text not null,
    start_time timestamptz not null,
    end_time timestamptz not null,
    expected_attendance integer not null,
    location_preference text,
    layout_preference text,
    equipment_requirements text,
    created_at timestamptz not null default now(),

    constraint event_change_request_sessions_pkey primary key (id),
    constraint event_change_request_sessions_change_request_id_fkey
        foreign key (change_request_id) references public.event_change_requests(id)
        on delete cascade,
    constraint event_change_request_sessions_session_id_fkey
        foreign key (session_id) references public.event_sessions(id)
        on delete set null,
    constraint event_change_request_sessions_name_check
        check (length(btrim(name)) > 0),
    constraint event_change_request_sessions_end_after_start
        check (end_time > start_time),
    constraint event_change_request_sessions_expected_attendance_check
        check (expected_attendance > 0),
    constraint event_change_request_sessions_one_per_session
        unique (change_request_id, session_id)
);

create index event_change_request_sessions_change_request_idx
    on public.event_change_request_sessions (change_request_id);

alter table public.event_change_request_sessions enable row level security;

create policy "Users can view sessions of change requests they can view"
    on public.event_change_request_sessions
    for select to public
    using (exists (
        select 1 from public.event_change_requests as change_request
        where change_request.id = event_change_request_sessions.change_request_id
    ));

-- Preserve the deployed ACL, rather than introducing a permission change.
-- ALL is version-aware: PostgreSQL 17+ also includes MAINTAIN, present in the
-- deployed ACL; PostgreSQL 16 (CI) grants the privileges available there.
revoke all on public.event_change_request_sessions from public;
grant all privileges on public.event_change_request_sessions
    to anon, authenticated, service_role;

commit;
