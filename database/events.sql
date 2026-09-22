-- ConnectSphere EVENTS entity.
-- This file is limited to the EVENTS table and the Submit Event Request
-- (T7-45) integrity and authorization requirements.
--
-- Design notes for T7-45:
--   * The Event Organiser does NOT choose a venue or specific equipment.
--     They describe what they need in free text (location_preference,
--     layout_preference, accessibility_requirements,
--     equipment_requirements). The Event Coordinator later searches for a
--     venue and Technical Support matches the equipment, each in their own
--     tables.
--   * coordinator_id stays null until an Event Coordinator is assigned
--     (T7-87). Nothing in this story fills it in.
--   * There is no is_draft column: a draft is status = 'draft' (T7-37), so
--     the lifecycle lives in exactly one column.

create table public.events (
    id uuid primary key default gen_random_uuid(),
    organiser_id uuid not null references public.profiles (id),
    coordinator_id uuid references public.profiles (id),
    name text not null,
    description text not null,
    purpose text not null,
    category text not null,
    start_time timestamptz not null,
    end_time timestamptz not null,
    expected_attendance integer not null,
    location_preference text,
    layout_preference text,
    accessibility_requirements text,
    equipment_requirements text,
    status text not null default 'submitted',
    created_at timestamptz not null default now(),

    constraint events_name_not_blank
        check (length(btrim(name)) > 0),
    constraint events_description_not_blank
        check (length(btrim(description)) > 0),
    constraint events_purpose_not_blank
        check (length(btrim(purpose)) > 0),
    constraint events_category_not_blank
        check (length(btrim(category)) > 0),
    constraint events_expected_attendance_positive
        check (expected_attendance > 0),
    constraint events_end_after_start
        check (end_time > start_time),
    -- The whole lifecycle is listed here so that no story invents its own
    -- spelling of a status. T7-45 only ever writes 'submitted'; the later
    -- values belong to stories in this and future sprints.
    constraint events_status_valid
        check (status in (
            'draft',
            'submitted',
            'under_review',
            'awaiting_clarification',
            'change_requested',
            'planning',
            'confirmed',
            'completed',
            'rejected',
            'cancelled'
        ))
);

-- An Organiser's own list of events is the common lookup.
create index events_organiser_id_idx on public.events (organiser_id);

grant select on public.events to authenticated;
grant insert on public.events to authenticated;

-- Mirrors public.is_venue_staff() in venues.sql.
create function public.is_organiser()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'organiser'
    );
$$;

revoke all on function public.is_organiser() from public;
grant execute on function public.is_organiser() to authenticated;

alter table public.events enable row level security;

-- Only an Organiser may submit, and only as themselves: without the
-- organiser_id check a signed-in Organiser could submit a request in
-- another Organiser's name.
create policy "Organisers can submit their own event requests"
    on public.events
    for insert
    to authenticated
    with check (
        public.is_organiser()
        and organiser_id = (select auth.uid())
    );

-- An Organiser sees only their own events. This is also what lets the
-- insert above return the created row, which the API needs for the
-- confirmation message.
create policy "Organisers can view their own events"
    on public.events
    for select
    to authenticated
    using (organiser_id = (select auth.uid()));
