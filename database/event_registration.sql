-- Registration period and attendee capacity for an event.
-- Run this only if events.sql, event_statuses.sql, event_sessions.sql and
-- venue_bookings.sql have already been applied.
-- Backward compatible: adds nullable columns and two functions; changes no
-- existing column or rule, so code on main keeps working.
--
-- Design notes:
--   * Organisers can only update their own drafts under row-level security,
--     so registration settings are saved through a function that touches
--     these four columns and nothing else. A broader update policy would
--     also let an organiser change an approved event's name, dates or status.
--   * Settings can be saved and previewed while the venue, equipment or
--     safety review is still pending. Publishing waits until every session's
--     venue, any equipment and the Safety Officer have all approved.
--   * Capacity is checked against the smallest approved venue, because
--     every session's attendees must fit in the room they are booked into.
--   * Once published, an event stays published.

-- 1. The columns. Nullable because an event has none of this until the
--    Organiser sets it up.
alter table public.events
    add column if not exists registration_opens_at timestamptz,
    add column if not exists registration_closes_at timestamptz,
    add column if not exists attendee_capacity integer,
    add column if not exists published_at timestamptz;

alter table public.events
    drop constraint if exists events_registration_closes_after_opens;
alter table public.events
    add constraint events_registration_closes_after_opens
    check (
        status = 'cancelled'
        or registration_opens_at is null
        or registration_closes_at is null
        or registration_closes_at > registration_opens_at
    );

alter table public.events
    drop constraint if exists events_attendee_capacity_positive;
alter table public.events
    add constraint events_attendee_capacity_positive
    check (attendee_capacity is null or attendee_capacity > 0);

-- 2. Save the registration settings, and publish the event when asked.
create or replace function public.save_event_registration(
    p_event_id uuid,
    p_opens_at timestamptz,
    p_closes_at timestamptz,
    p_capacity integer,
    p_publish boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    smallest_venue_capacity integer;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can set up registration';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status in (
        'draft', 'under_review', 'rejected', 'completed',
        'cancellation_requested', 'cancelled'
    ) then
        raise exception 'Registration cannot be set up for an event in its current status';
    end if;

    if current_event.registration_closes_at is not null
        and current_event.registration_closes_at <= now() then
        raise exception 'Registration has already closed';
    end if;

    if p_closes_at <= p_opens_at then
        raise exception 'Registration must close after it opens';
    end if;

    if current_event.start_time is not null
        and p_closes_at > current_event.start_time then
        raise exception 'Registration must close before the event starts';
    end if;

    select min(v.capacity) into smallest_venue_capacity
    from public.venue_bookings b
    join public.venues v on v.id = b.venue_id
    where b.event_id = p_event_id and b.status = 'APPROVED';

    if smallest_venue_capacity is not null
        and p_capacity > smallest_venue_capacity then
        raise exception 'Attendee capacity cannot exceed the venue capacity';
    end if;

    -- Publishing checks each approval itself rather than trusting the
    -- 'confirmed' status: a venue or equipment request can be affected
    -- after the Safety Officer approved the event.
    if p_publish then
        if exists (
            select 1 from public.event_sessions s
            where s.event_id = p_event_id
              and not exists (
                  select 1 from public.venue_bookings b
                  where b.session_id = s.id and b.status = 'APPROVED'
              )
        ) or not exists (
            select 1 from public.venue_bookings b
            where b.event_id = p_event_id and b.status = 'APPROVED'
        ) then
            raise exception 'Every session needs an approved venue before publishing';
        end if;

        if exists (
            select 1 from public.equipment_requests r
            where r.event_id = p_event_id
              and r.status not in ('Approved', 'Rejected', 'Cancelled')
        ) then
            raise exception 'Every equipment request must be approved before publishing';
        end if;

        if current_event.status <> 'confirmed'
            or coalesce((
                select decision from public.event_safety_reviews
                where event_id = p_event_id
                order by created_at desc
                limit 1
            ), '') <> 'APPROVED' then
            raise exception 'The Safety Officer must approve the event before publishing';
        end if;
    end if;

    update public.events
    set registration_opens_at = p_opens_at,
        registration_closes_at = p_closes_at,
        attendee_capacity = p_capacity,
        published_at = case
            when p_publish then coalesce(published_at, now())
            else published_at
        end
    where id = p_event_id;
end;
$$;

revoke all on function public.save_event_registration(uuid, timestamptz, timestamptz, integer, boolean)
    from public;
grant execute on function public.save_event_registration(uuid, timestamptz, timestamptz, integer, boolean)
    to authenticated;

-- 3. The venue and equipment arranged for the Organiser's own event, for the
--    registration preview. Organisers cannot read venue_bookings or
--    equipment_requests under row-level security, and only need these few
--    fields: where each session is held and whether approval is pending.
--    Rejected and cancelled arrangements hold nothing, so they are left out.
create or replace function public.list_event_arrangements(p_event_id uuid)
returns table (
    kind text,
    session_id uuid,
    status text,
    venue_name text,
    venue_location text,
    venue_capacity integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select 'venue', b.session_id, b.status::text, v.name, v.location, v.capacity
    from public.venue_bookings b
    join public.venues v on v.id = b.venue_id
    join public.events e on e.id = b.event_id
    where b.event_id = p_event_id
      and e.organiser_id = auth.uid()
      and b.status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY')
    union all
    select 'equipment', r.session_id, r.status, null, null, null
    from public.equipment_requests r
    join public.events e on e.id = r.event_id
    where r.event_id = p_event_id
      and e.organiser_id = auth.uid()
      and r.status not in ('Rejected', 'Cancelled');
$$;

revoke all on function public.list_event_arrangements(uuid) from public;
grant execute on function public.list_event_arrangements(uuid) to authenticated;
