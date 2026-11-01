-- Attendees registering for published events.
-- Run this only if events.sql, event_sessions.sql, venue_bookings.sql and
-- event_registration.sql have already been applied.
-- Includes T7-47 withdrawal support. Existing registrations remain active;
-- withdrawn rows stay as history and no longer occupy a place.
--
-- Design notes:
--   * Attendees cannot read events, sessions or venue bookings under
--     row-level security, so published events are listed through a
--     function that returns only what an attendee needs to see.
--   * Spots left is the event's attendee_capacity minus active registrations,
--     so every registration lowers it by one and there is no second
--     counter that could drift out of step.
--   * register_for_event locks the event row before counting, so two
--     attendees taking the last spot at the same time are handled one
--     after the other and the second is told the event is full.
--   * The registration is a single insert: when any check fails nothing is
--     saved, and the spot count is unchanged.
--   * The registration email is always the account's own email, read from
--     auth.users, so nobody can register (and receive the confirmation,
--     with their details) under someone else's address. Each account
--     holds at most one active registration per event.
--   * Attendees no longer give an address, and the contact number is
--     optional. The address column stays, nullable, so registrations made
--     before keep their data.
--   * The unique index is the last guard against registering twice with
--     the same account.

-- 1. The table. Rows are only written by register_for_event.
create table if not exists public.event_registrations (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    attendee_id uuid not null references public.profiles(id),
    full_name text not null check (length(btrim(full_name)) > 0),
    email text not null check (length(btrim(email)) > 0),
    address text check (length(btrim(address)) > 0),
    contact_number text check (length(btrim(contact_number)) > 0),
    created_at timestamptz not null default now()
);

-- For databases created before the address was removed and the contact
-- number made optional.
alter table public.event_registrations
    alter column address drop not null,
    alter column contact_number drop not null;

alter table public.event_registrations
    add column if not exists status text not null default 'registered',
    add column if not exists withdrawn_at timestamptz;
alter table public.event_registrations
    drop constraint if exists event_registrations_status_valid,
    drop constraint if exists event_registrations_withdrawal_time_valid;
alter table public.event_registrations
    add constraint event_registrations_status_valid
        check (status in ('registered', 'withdrawn')),
    add constraint event_registrations_withdrawal_time_valid
        check ((status = 'withdrawn') = (withdrawn_at is not null));

-- Re-registration creates a new row, preserving earlier withdrawal history.
drop index if exists public.event_registrations_one_per_attendee;
create unique index if not exists event_registrations_one_active_per_attendee
    on public.event_registrations (event_id, attendee_id)
    where status = 'registered';

-- Removed: the email is now the account's own, so one per account covers it.
drop index if exists public.event_registrations_one_per_email;

alter table public.event_registrations enable row level security;
grant select on public.event_registrations to authenticated;
-- Writes are authorised by the RPCs, never by broad table UPDATE access.
revoke insert, update, delete on public.event_registrations from public, anon, authenticated;

drop policy if exists "Attendees can view their own registrations"
    on public.event_registrations;
create policy "Attendees can view their own registrations"
    on public.event_registrations
    for select
    to authenticated
    using (attendee_id = (select auth.uid()));

-- 2. Published events as an attendee sees them. Pass an event id for one
--    event, or nothing for all of them. The catalogue contains confirmed
--    events; a cancelled published event remains accessible by id.
-- Preserve the shared database's status output. Only the older repository
-- signature needs recreation; RESTRICT stops rather than deleting dependants.
do $upgrade_published_events$
begin
    if exists (
        select 1 from pg_proc p
        where p.oid = to_regprocedure('public.list_published_events(uuid)')
          and p.proargnames[2:array_length(p.proargnames, 1)] = array[
              'id', 'name', 'description', 'purpose', 'category', 'category_other',
              'start_time', 'end_time', 'accessibility_requirements',
              'registration_opens_at', 'registration_closes_at', 'attendee_capacity',
              'spots_left', 'is_registered', 'sessions'
          ]::text[]
    ) then
        drop function public.list_published_events(uuid) restrict;
    end if;
end;
$upgrade_published_events$;

create or replace function public.list_published_events(p_event_id uuid default null)
returns table (
    id uuid,
    name text,
    description text,
    purpose text,
    category text,
    category_other text,
    start_time timestamptz,
    end_time timestamptz,
    accessibility_requirements text,
    registration_opens_at timestamptz,
    registration_closes_at timestamptz,
    attendee_capacity integer,
    spots_left integer,
    is_registered boolean,
    sessions jsonb,
    status text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        e.id,
        e.name,
        e.description,
        e.purpose,
        e.category,
        e.category_other,
        e.start_time,
        e.end_time,
        e.accessibility_requirements,
        e.registration_opens_at,
        e.registration_closes_at,
        e.attendee_capacity,
        greatest(
            e.attendee_capacity - (
                select count(*) from public.event_registrations r
                where r.event_id = e.id and r.status = 'registered'
            ),
            0
        )::integer,
        exists (
            select 1 from public.event_registrations r
            where r.event_id = e.id and r.attendee_id = auth.uid()
              and r.status = 'registered'
        ),
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', s.id,
                    'name', s.name,
                    'start_time', s.start_time,
                    'end_time', s.end_time,
                    'venue_name', v.name,
                    'venue_location', v.location
                )
                order by s.start_time
            )
            from public.event_sessions s
            left join public.venue_bookings b
                on b.session_id = s.id and b.status = 'APPROVED'
            left join public.venues v on v.id = b.venue_id
            where s.event_id = e.id
        ), '[]'::jsonb),
        e.status
    from public.events e
    where auth.uid() is not null
      and (
          e.status = 'confirmed'
          or (p_event_id is not null and e.status = 'cancelled')
      )
      and e.published_at is not null
      and (p_event_id is null or e.id = p_event_id)
    order by e.start_time;
$$;

revoke all on function public.list_published_events(uuid) from public;
grant execute on function public.list_published_events(uuid) to authenticated;

-- 3. Register the signed-in attendee for an event, under their account
--    email. Returns the new registration's id. A blank contact number is
--    saved as null.
-- Replaces earlier versions that took the email and the address.
drop function if exists public.register_for_event(uuid, text, text, text, text);
drop function if exists public.register_for_event(uuid, text, text, text);

create or replace function public.register_for_event(
    p_event_id uuid,
    p_full_name text,
    p_contact_number text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    account_email text;
    registered_count integer;
    registration_id uuid;
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles
        where profiles.id = auth.uid() and profiles.role = 'attendee'
    ) then
        raise exception 'Only a signed-in attendee can register for an event';
    end if;

    select lower(btrim(users.email)) into account_email
    from auth.users
    where users.id = auth.uid();

    if account_email is null or account_email = '' then
        raise exception 'This account has no email address';
    end if;

    -- The lock makes registrations for the same event wait for each other,
    -- so the spot count below cannot be read twice before either insert.
    select * into current_event
    from public.events
    where events.id = p_event_id
      and events.status = 'confirmed'
      and events.published_at is not null
    for update;

    if not found then
        raise exception 'Event was not found';
    end if;

    if current_event.registration_opens_at is null
        or now() < current_event.registration_opens_at then
        raise exception 'Registration has not opened yet';
    end if;

    if current_event.registration_closes_at is null
        or now() >= current_event.registration_closes_at then
        raise exception 'Registration has closed';
    end if;

    if exists (
        select 1 from public.event_registrations r
        where r.event_id = p_event_id and r.attendee_id = auth.uid()
          and r.status = 'registered'
    ) then
        raise exception 'This account is already registered for the event';
    end if;

    select count(*) into registered_count
    from public.event_registrations r
    where r.event_id = p_event_id and r.status = 'registered';

    if current_event.attendee_capacity is null
        or registered_count >= current_event.attendee_capacity then
        raise exception 'Event is full';
    end if;

    insert into public.event_registrations (
        event_id, attendee_id, full_name, email, contact_number
    )
    values (
        p_event_id,
        auth.uid(),
        btrim(p_full_name),
        account_email,
        nullif(btrim(p_contact_number), '')
    )
    returning event_registrations.id into registration_id;

    return registration_id;
end;
$$;

revoke all on function public.register_for_event(uuid, text, text)
    from public;
grant execute on function public.register_for_event(uuid, text, text)
    to authenticated;

-- 4. The signed-in attendee's registrations, with the event each is for,
--    newest first. Pass a registration id for one, or nothing for all.
--    The event is included even if it is later cancelled, so the attendee
--    can see what happened to it.
-- Dropped first because the result now includes withdrawal information.
drop function if exists public.list_my_registrations(uuid);

create or replace function public.list_my_registrations(p_registration_id uuid default null)
returns table (
    id uuid,
    event_id uuid,
    attendee_id uuid,
    full_name text,
    email text,
    contact_number text,
    created_at timestamptz,
    event_name text,
    event_start_time timestamptz,
    event_end_time timestamptz,
    event_status text,
    status text,
    withdrawn_at timestamptz,
    can_withdraw boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        r.id,
        r.event_id,
        r.attendee_id,
        r.full_name,
        r.email,
        r.contact_number,
        r.created_at,
        e.name,
        e.start_time,
        e.end_time,
        e.status,
        r.status,
        r.withdrawn_at,
        (r.status = 'registered'
         and e.status in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed')
         and e.start_time > now()) is true
    from public.event_registrations r
    join public.events e on e.id = r.event_id
    where r.attendee_id = auth.uid()
      and (p_registration_id is null or r.id = p_registration_id)
    order by r.created_at desc;
$$;

revoke all on function public.list_my_registrations(uuid) from public;
grant execute on function public.list_my_registrations(uuid) to authenticated;

-- 5. How many attendees hold active places at the Organiser's own event.
--    Organisers cannot read event_registrations under row-level security,
--    and only need the number, not attendees' names or phone numbers.
--    Null when the event is not the caller's own, so an id cannot be used
--    to probe other Organisers' events.
create or replace function public.count_event_registrations(p_event_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
    select (
        select count(*) from public.event_registrations r
        where r.event_id = e.id and r.status = 'registered'
    )::integer
    from public.events e
    where e.id = p_event_id
      and e.organiser_id = auth.uid();
$$;

revoke all on function public.count_event_registrations(uuid) from public;
grant execute on function public.count_event_registrations(uuid) to authenticated;

-- 6. Withdraw an owned registration. Use the same parent-first lock order
-- as registration, so concurrent actions cannot release or occupy a place twice.
create or replace function public.withdraw_event_registration(p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_event_id uuid;
    current_event public.events%rowtype;
    current_registration public.event_registrations%rowtype;
    changed boolean := false;
    registration jsonb;
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'attendee'
    ) then
        raise exception 'Only a signed-in attendee can withdraw a registration';
    end if;

    -- Locate the owned row without locking the child before its parent.
    select event_id into target_event_id
    from public.event_registrations
    where id = p_registration_id and attendee_id = auth.uid();
    if not found then
        raise exception 'Registration was not found';
    end if;

    select * into current_event from public.events
    where id = target_event_id for update;
    if not found then
        raise exception 'Registration was not found';
    end if;

    select * into current_registration from public.event_registrations
    where id = p_registration_id and attendee_id = auth.uid() for update;
    if not found then
        raise exception 'Registration was not found';
    end if;

    -- Retries preserve the first withdrawal's timestamp and notification state.
    if current_registration.status <> 'withdrawn' then
        if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
            raise exception 'Withdrawal is unavailable for an event that has ended or been cancelled';
        end if;
        -- A lock wait may cross the cutoff, so transaction start time is unsafe.
        if current_event.start_time is null or current_event.start_time <= clock_timestamp() then
            raise exception 'Withdrawal is unavailable once the event has started';
        end if;

        update public.event_registrations
        set status = 'withdrawn', withdrawn_at = clock_timestamp()
        where id = p_registration_id;
        changed := true;
    end if;

    select to_jsonb(r) into registration
    from public.list_my_registrations(p_registration_id) r;
    return jsonb_build_object('registration', registration, 'changed', changed);
end;
$$;

revoke all on function public.withdraw_event_registration(uuid) from public, anon;
grant execute on function public.withdraw_event_registration(uuid) to authenticated;
