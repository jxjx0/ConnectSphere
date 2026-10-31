-- Event status badges.
--
-- An event's status now only says where it is in the main path:
--   draft, under_review, planning, awaiting_safety_check, confirmed,
--   completed, rejected, cancelled.
--
-- Clarifications, change requests and cancellation requests no longer
-- replace the status. Each lives only in its own table, and is "open" while
-- its status is 'pending'. All three tables now record the same things:
--   status      pending, then answered / approved / rejected / expired
--   created_at  when it was opened
--   closed_at   when it stopped being pending
--   closed_by   who closed it (null when it expired)
--
-- Two rules are enforced by triggers so every code path follows them:
--   1. An event cannot move forward (accept, send to safety check, confirm)
--      while any request is open.
--   2. When an event ends (completed, rejected or cancelled), anything still
--      open on it expires.
--
-- Requires: events.sql, event_clarifications.sql, event_change_requests.sql,
-- event_cancellation_requests.sql, event_completion.sql (and the functions
-- they define).

begin;

-- ---------------------------------------------------------------------------
-- 1. Standardise the three request tables
-- ---------------------------------------------------------------------------

-- Clarifications: add a status and use the shared column names.
alter table public.event_clarifications
    rename column requested_at to created_at;
alter table public.event_clarifications
    rename column responded_at to closed_at;
alter table public.event_clarifications
    add column status text not null default 'pending',
    add column closed_by uuid references public.profiles (id);

update public.event_clarifications
set status = 'answered', closed_by = organiser_id
where closed_at is not null;

alter table public.event_clarifications
    add constraint event_clarifications_status_valid
    check (status in ('pending', 'answered', 'expired'));

-- Change requests.
alter table public.event_change_requests
    rename column reviewed_at to closed_at;
alter table public.event_change_requests
    rename column rejection_reason to decision_reason;
-- The reason check has a different name in the repository schema
-- (..._not_blank) and the shared database (..._check), so replace either.
alter table public.event_change_requests
    drop constraint if exists event_change_requests_rejection_reason_check,
    drop constraint if exists event_change_requests_rejection_reason_not_blank;
alter table public.event_change_requests
    add constraint event_change_requests_decision_reason_not_blank
    check (decision_reason is null or length(btrim(decision_reason)) > 0);
alter table public.event_change_requests
    add column closed_by uuid references public.profiles (id);

-- Cancellation requests.
alter table public.event_cancellation_requests
    rename column decided_at to closed_at;
alter table public.event_cancellation_requests
    rename column decision_by to closed_by;

-- At most one open request of each type per event (change and cancellation
-- requests already have this).
create unique index event_clarifications_one_pending_per_event
    on public.event_clarifications (event_id)
    where status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Move events out of the old side-request statuses
-- ---------------------------------------------------------------------------

-- Each side request saved the status it replaced. Requests can be stacked
-- (e.g. a cancellation on top of a clarification), so keep restoring until
-- every event is back on the main path.
do $$
declare
    moved integer;
begin
    loop
        update public.events e
        set status = case e.status
            when 'awaiting_clarification' then (
                select c.previous_status from public.event_clarifications c
                where c.event_id = e.id and c.status = 'pending')
            when 'change_requested' then (
                select r.event_status_before_request from public.event_change_requests r
                where r.event_id = e.id and r.status = 'pending')
            when 'cancellation_requested' then (
                select r.previous_event_status from public.event_cancellation_requests r
                where r.event_id = e.id and r.status = 'pending')
        end
        where e.status in ('awaiting_clarification', 'change_requested', 'cancellation_requested');
        get diagnostics moved = row_count;
        exit when moved = 0;
    end loop;
end;
$$;

-- Requests left open on events that have already ended are obsolete.
update public.event_clarifications c
set status = 'expired', closed_at = now()
from public.events e
where e.id = c.event_id and c.status = 'pending'
  and e.status in ('completed', 'rejected', 'cancelled');
update public.event_change_requests r
set status = 'expired', closed_at = now()
from public.events e
where e.id = r.event_id and r.status = 'pending'
  and e.status in ('completed', 'rejected', 'cancelled');
update public.event_cancellation_requests r
set status = 'expired', closed_at = now()
from public.events e
where e.id = r.event_id and r.status = 'pending'
  and e.status in ('completed', 'rejected', 'cancelled');

-- The saved statuses are no longer needed.
alter table public.event_clarifications drop column previous_status;
alter table public.event_change_requests drop column event_status_before_request;
alter table public.event_cancellation_requests drop column previous_event_status;

alter table public.events drop constraint events_status_valid;
alter table public.events
    add constraint events_status_valid
    check (status in (
        'draft', 'under_review', 'planning', 'awaiting_safety_check',
        'confirmed', 'completed', 'rejected', 'cancelled'
    ));

-- ---------------------------------------------------------------------------
-- 3. Shared helper and the two rules
-- ---------------------------------------------------------------------------

create or replace function public.event_has_open_requests(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.event_clarifications
                   where event_id = p_event_id and status = 'pending')
        or exists (select 1 from public.event_change_requests
                   where event_id = p_event_id and status = 'pending')
        or exists (select 1 from public.event_cancellation_requests
                   where event_id = p_event_id and status = 'pending');
$$;

revoke all on function public.event_has_open_requests(uuid) from public, anon;
grant execute on function public.event_has_open_requests(uuid) to authenticated, service_role;

-- Rule 1: no moving forward while anything is open.
create or replace function public.block_forward_move_while_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if (old.status, new.status) in (
        ('under_review', 'planning'),
        ('planning', 'awaiting_safety_check'),
        ('planning', 'confirmed'),
        ('awaiting_safety_check', 'confirmed')
    ) and public.event_has_open_requests(new.id) then
        raise exception 'Close the open clarification, change or cancellation request before moving this event forward'
            using errcode = 'P0001';
    end if;
    return new;
end;
$$;

revoke all on function public.block_forward_move_while_open() from public, anon, authenticated;

drop trigger if exists events_block_forward_move_while_open on public.events;
create trigger events_block_forward_move_while_open
before update of status on public.events
for each row
when (old.status is distinct from new.status)
execute function public.block_forward_move_while_open();

-- Rule 2: when an event ends, anything still open expires.
create or replace function public.expire_open_requests_when_event_ends()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.event_clarifications
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    update public.event_change_requests
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    update public.event_cancellation_requests
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    return new;
end;
$$;

revoke all on function public.expire_open_requests_when_event_ends() from public, anon, authenticated;

drop trigger if exists events_expire_open_requests on public.events;
create trigger events_expire_open_requests
after update of status on public.events
for each row
when (old.status is distinct from new.status
      and new.status in ('completed', 'rejected', 'cancelled'))
execute function public.expire_open_requests_when_event_ends();

-- New requests cannot be opened on an event that has ended.
create or replace function public.reject_completed_event_request()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    event_status text;
begin
    if new.status <> 'pending' then
        return new;
    end if;

    select status into event_status from public.events
    where id = new.event_id for update;
    if not found then
        raise exception 'Event request was not found';
    end if;
    if event_status in ('completed', 'rejected', 'cancelled') then
        if tg_table_name = 'event_change_requests' then
            raise exception 'Event cannot be changed in its current status';
        elsif tg_table_name = 'event_clarifications' then
            raise exception 'Event cannot be clarified in its current status';
        end if;
        raise exception 'Event cannot be cancelled in its current status';
    end if;
    return new;
end;
$$;

drop trigger if exists event_clarifications_reject_completed on public.event_clarifications;
create trigger event_clarifications_reject_completed
before insert on public.event_clarifications
for each row execute function public.reject_completed_event_request();

-- ---------------------------------------------------------------------------
-- 4. Clarifications
-- ---------------------------------------------------------------------------

create or replace function public.request_event_clarification(
    p_event_id uuid, p_coordinator_id uuid, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_coordinator_id
        or not public.is_coordinator() then
        raise exception 'Only the assigned Coordinator can request clarification';
    end if;

    if p_notes is null or length(btrim(p_notes)) not between 1 and 5000 then
        raise exception 'Clarification notes must contain between 1 and 5000 characters';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = p_coordinator_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;
    if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
        raise exception 'Event cannot be clarified in its current status';
    end if;
    if exists (select 1 from public.event_clarifications
               where event_id = p_event_id and status = 'pending') then
        raise exception 'A clarification is already waiting for a response';
    end if;
    if exists (select 1 from public.event_cancellation_requests
               where event_id = p_event_id and status = 'pending') then
        raise exception 'Review the pending cancellation request first';
    end if;

    insert into public.event_clarifications (
        event_id, organiser_id, coordinator_id, coordinator_notes
    ) values (
        p_event_id, current_event.organiser_id, p_coordinator_id, btrim(p_notes)
    ) returning id into clarification_id;

    update public.events set updated_at = now() where id = p_event_id;

    return clarification_id;
end;
$$;

create or replace function public.respond_to_event_clarification(
    p_event_id uuid, p_organiser_id uuid, p_response text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_organiser_id
        or not public.is_organiser() then
        raise exception 'Only the signed-in Organiser can respond to clarification';
    end if;

    if p_response is null or length(btrim(p_response)) not between 1 and 5000 then
        raise exception 'Your response must contain between 1 and 5000 characters';
    end if;

    perform 1 from public.events
    where id = p_event_id and organiser_id = p_organiser_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    update public.event_clarifications
    set organiser_response = btrim(p_response),
        status = 'answered',
        closed_at = now(),
        closed_by = p_organiser_id
    where event_id = p_event_id and status = 'pending'
    returning id into clarification_id;

    if clarification_id is null then
        raise exception 'No clarification is awaiting a response';
    end if;

    update public.events set updated_at = now() where id = p_event_id;

    return clarification_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Change requests
-- ---------------------------------------------------------------------------

-- Old versions, replaced by the session-aware functions and no longer called.
drop function if exists public.submit_event_change_request(uuid, uuid, jsonb);
drop function if exists public.approve_event_change_request(uuid);

create or replace function public.submit_session_change_request(p_event_id uuid, p_changes jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    change_request_id uuid;
    proposed jsonb;
    current_session public.event_sessions%rowtype;
    proposed_ids uuid[] := array[]::uuid[];
    proposed_id uuid;
    proposed_name text;
    proposed_start timestamptz;
    proposed_end timestamptz;
    sessions_changed boolean := false;
    new_category_other text;
    new_accessibility text;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can submit a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status not in ('under_review', 'planning', 'confirmed') then
        raise exception 'Event cannot be changed in its current status';
    end if;

    if exists (
        select 1 from public.event_change_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending change request already exists';
    end if;

    if exists (
        select 1 from public.event_cancellation_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'Event cannot be changed while a cancellation request is pending';
    end if;

    if jsonb_typeof(p_changes->'sessions') is distinct from 'array'
       or jsonb_array_length(p_changes->'sessions') = 0 then
        raise exception 'Keep at least one session' using errcode = '22023';
    end if;

    for proposed in select * from jsonb_array_elements(p_changes->'sessions')
    loop
        proposed_id := nullif(proposed->>'session_id', '')::uuid;
        proposed_name := btrim(proposed->>'name');
        proposed_start := (proposed->>'start_time')::timestamptz;
        proposed_end := (proposed->>'end_time')::timestamptz;

        if proposed_id is null then
            sessions_changed := true;
            if proposed_start <= now() then
                raise exception '%: Start time must be in the future', proposed_name
                    using errcode = '22023';
            end if;
            continue;
        end if;

        if proposed_id = any(proposed_ids) then
            raise exception 'Each session can only be listed once' using errcode = '22023';
        end if;
        proposed_ids := array_append(proposed_ids, proposed_id);

        select * into current_session
        from public.event_sessions
        where id = proposed_id and event_id = p_event_id;

        if not found then
            raise exception 'A session does not belong to this event' using errcode = '22023';
        end if;

        if current_session.name is distinct from proposed_name
           or date_trunc('minute', current_session.start_time)
              is distinct from date_trunc('minute', proposed_start)
           or date_trunc('minute', current_session.end_time)
              is distinct from date_trunc('minute', proposed_end)
           or current_session.expected_attendance
              is distinct from (proposed->>'expected_attendance')::integer
           or current_session.location_preference
              is distinct from nullif(btrim(proposed->>'location_preference'), '')
           or current_session.layout_preference
              is distinct from nullif(btrim(proposed->>'layout_preference'), '')
           or current_session.equipment_requirements
              is distinct from nullif(btrim(proposed->>'equipment_requirements'), '') then
            sessions_changed := true;
            if current_session.start_time <= now() then
                raise exception '%: This session has already started and cannot be changed',
                    current_session.name using errcode = '22023';
            end if;
            if proposed_start <= now() then
                raise exception '%: Start time must be in the future', proposed_name
                    using errcode = '22023';
            end if;
        end if;
    end loop;

    select * into current_session
    from public.event_sessions
    where event_id = p_event_id
      and not (id = any(proposed_ids))
      and start_time <= now()
    limit 1;

    if found then
        raise exception '%: This session has already started and cannot be removed',
            current_session.name using errcode = '22023';
    end if;

    if exists (
        select 1 from public.event_sessions
        where event_id = p_event_id and not (id = any(proposed_ids))
    ) then
        sessions_changed := true;
    end if;

    new_category_other := nullif(btrim(p_changes->>'category_other'), '');
    new_accessibility := nullif(btrim(p_changes->>'accessibility_requirements'), '');

    if not sessions_changed
       and current_event.name is not distinct from btrim(p_changes->>'name')
       and current_event.description is not distinct from btrim(p_changes->>'description')
       and current_event.purpose is not distinct from btrim(p_changes->>'purpose')
       and current_event.category::text is not distinct from p_changes->>'category'
       and current_event.category_other is not distinct from new_category_other
       and current_event.accessibility_requirements is not distinct from new_accessibility then
        raise exception 'No event details were changed';
    end if;

    insert into public.event_change_requests (
        event_id, organiser_id,
        name, description, reason_for_change, purpose, category,
        category_other, accessibility_requirements,
        start_time, end_time, expected_attendance
    )
    select
        p_event_id, auth.uid(),
        btrim(p_changes->>'name'), btrim(p_changes->>'description'),
        btrim(p_changes->>'reason_for_change'), btrim(p_changes->>'purpose'),
        p_changes->>'category', new_category_other, new_accessibility,
        min((session->>'start_time')::timestamptz),
        max((session->>'end_time')::timestamptz),
        max((session->>'expected_attendance')::integer)
    from jsonb_array_elements(p_changes->'sessions') as session
    returning id into change_request_id;

    insert into public.event_change_request_sessions (
        change_request_id, session_id, name, start_time, end_time,
        expected_attendance, location_preference, layout_preference,
        equipment_requirements
    )
    select
        change_request_id,
        nullif(session->>'session_id', '')::uuid,
        btrim(session->>'name'),
        (session->>'start_time')::timestamptz,
        (session->>'end_time')::timestamptz,
        (session->>'expected_attendance')::integer,
        nullif(btrim(session->>'location_preference'), ''),
        nullif(btrim(session->>'layout_preference'), ''),
        nullif(btrim(session->>'equipment_requirements'), '')
    from jsonb_array_elements(p_changes->'sessions') as session;

    update public.events set updated_at = now() where id = p_event_id;

    return change_request_id;
end;
$$;

create or replace function public.approve_session_change_request(
    p_event_id uuid, p_cancel_booking_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
    proposal public.event_change_request_sessions%rowtype;
    current_session public.event_sessions%rowtype;
    removed_ids uuid[];
    rebooked_ids uuid[] := array[]::uuid[];
    material boolean := false;
    status_before text;
    next_status text;
    cancelled_bookings jsonb;
    affected_bookings integer;
    affected_requests integer;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    -- Lock the event first, the same order every request function uses.
    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    select * into current_request
    from public.event_change_requests
    where event_id = p_event_id and status = 'pending'
    for update;

    if not found then
        raise exception 'Change request is no longer pending';
    end if;

    select coalesce(array_agg(session.id), array[]::uuid[]) into removed_ids
    from public.event_sessions as session
    where session.event_id = p_event_id
      and not exists (
          select 1 from public.event_change_request_sessions as kept
          where kept.change_request_id = current_request.id
            and kept.session_id = session.id
      );

    select * into current_session
    from public.event_sessions
    where id = any(removed_ids) and start_time <= now()
    limit 1;
    if found then
        raise exception '%: This session has already started and cannot be removed',
            current_session.name using errcode = '22023';
    end if;

    if cardinality(removed_ids) > 0 then
        material := true;
        rebooked_ids := rebooked_ids || removed_ids;
    end if;

    for proposal in
        select * from public.event_change_request_sessions
        where change_request_id = current_request.id
    loop
        if proposal.session_id is null then
            if proposal.start_time <= now() then
                raise exception '%: Start time must be in the future', proposal.name
                    using errcode = '22023';
            end if;
            insert into public.event_sessions (
                event_id, name, start_time, end_time, expected_attendance,
                location_preference, layout_preference, equipment_requirements
            ) values (
                p_event_id, proposal.name, proposal.start_time, proposal.end_time,
                proposal.expected_attendance, proposal.location_preference,
                proposal.layout_preference, proposal.equipment_requirements
            );
            material := true;
            continue;
        end if;

        select * into current_session
        from public.event_sessions
        where id = proposal.session_id and event_id = p_event_id
        for update;

        if not found then
            raise exception '%: This session no longer exists', proposal.name
                using errcode = '22023';
        end if;

        if current_session.name is distinct from proposal.name
           or date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
           or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time)
           or current_session.expected_attendance is distinct from proposal.expected_attendance
           or current_session.location_preference is distinct from proposal.location_preference
           or current_session.layout_preference is distinct from proposal.layout_preference
           or current_session.equipment_requirements is distinct from proposal.equipment_requirements then
            if current_session.start_time <= now() then
                raise exception '%: This session has already started and cannot be changed',
                    current_session.name using errcode = '22023';
            end if;

            if date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
               or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time)
               or current_session.expected_attendance is distinct from proposal.expected_attendance
               or current_session.location_preference is distinct from proposal.location_preference
               or current_session.layout_preference is distinct from proposal.layout_preference
               or current_session.equipment_requirements is distinct from proposal.equipment_requirements then
                material := true;
            end if;

            if date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
               or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time) then
                rebooked_ids := array_append(rebooked_ids, current_session.id);
            end if;

            update public.event_sessions
            set name = proposal.name,
                start_time = proposal.start_time,
                end_time = proposal.end_time,
                expected_attendance = proposal.expected_attendance,
                location_preference = proposal.location_preference,
                layout_preference = proposal.layout_preference,
                equipment_requirements = proposal.equipment_requirements
            where id = current_session.id;
        end if;
    end loop;

    if current_event.accessibility_requirements
       is distinct from current_request.accessibility_requirements then
        material := true;
    end if;

    with cancelled as (
        update public.venue_bookings
        set status = 'CANCELLED',
            cancellation_reason = 'Its session was changed by an approved change request.',
            cancelled_at = now(),
            cancelled_by = auth.uid()
        where session_id = any(rebooked_ids)
          and status = 'PENDING_VENUE_APPROVAL'
          and booking_id = any(coalesce(p_cancel_booking_ids, array[]::uuid[]))
        returning booking_id, venue_id, session_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'booking_id', cancelled.booking_id,
        'venue_name', venue.name,
        'session_name', session.name
    )), '[]'::jsonb)
    into cancelled_bookings
    from cancelled
    left join public.venues as venue on venue.id = cancelled.venue_id
    left join public.event_sessions as session on session.id = cancelled.session_id;

    update public.venue_bookings
    set status = 'AFFECTED_BY_SESSION_CHANGE'
    where session_id = any(rebooked_ids) and status = 'APPROVED';
    get diagnostics affected_bookings = row_count;

    update public.equipment_requests
    set status = 'Affected by Session Change'
    where session_id = any(rebooked_ids)
      and status in ('Pending Technical Approval', 'Approved');
    get diagnostics affected_requests = row_count;

    delete from public.event_sessions where id = any(removed_ids);

    -- A material change to a confirmed event needs replanning.
    status_before := current_event.status;
    next_status := case
        when material and current_event.status = 'confirmed' then 'planning'
        else current_event.status
    end;

    update public.event_change_requests
    set status = 'approved',
        closed_at = now(),
        closed_by = auth.uid(),
        decision_reason = null
    where id = current_request.id
    returning * into current_request;

    update public.events
    set name = current_request.name,
        description = current_request.description,
        purpose = current_request.purpose,
        category = current_request.category,
        category_other = current_request.category_other,
        accessibility_requirements = current_request.accessibility_requirements,
        status = next_status,
        updated_at = now()
    where id = p_event_id
    returning * into current_event;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request),
        'cancelled_bookings', cancelled_bookings,
        'affected_bookings', affected_bookings,
        'affected_equipment_requests', affected_requests,
        'returned_to_planning', status_before = 'confirmed' and next_status = 'planning'
    );
end;
$$;

create or replace function public.reject_event_change_request(p_event_id uuid, p_rejection_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    if p_rejection_reason is null or length(btrim(p_rejection_reason)) = 0 then
        raise exception 'A reason is required to reject a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    update public.event_change_requests
    set status = 'rejected',
        decision_reason = btrim(p_rejection_reason),
        closed_at = now(),
        closed_by = auth.uid()
    where event_id = p_event_id and status = 'pending'
    returning * into current_request;

    if current_request.id is null then
        raise exception 'Change request is no longer pending';
    end if;

    update public.events
    set updated_at = now()
    where id = p_event_id
    returning * into current_event;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Cancellation requests
-- ---------------------------------------------------------------------------

create or replace function public.submit_event_cancellation_request(p_event_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    cancellation_request_id uuid;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can request event cancellation';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if exists (
        select 1 from public.event_cancellation_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending cancellation request already exists';
    end if;

    if current_event.status not in ('planning', 'awaiting_safety_check', 'confirmed') then
        raise exception 'Event cannot be cancelled in its current status';
    end if;

    insert into public.event_cancellation_requests (event_id, organiser_id, reason)
    values (p_event_id, auth.uid(), btrim(p_reason))
    returning id into cancellation_request_id;

    update public.events set updated_at = now() where id = p_event_id;

    return cancellation_request_id;
end;
$$;

create or replace function public.review_event_cancellation_request(
    p_event_id uuid, p_decision text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_cancellation_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review cancellation requests';
    end if;

    if p_decision not in ('approve', 'reject') then
        raise exception 'Cancellation decision must be approve or reject';
    end if;

    if p_reason is null or length(btrim(p_reason)) = 0 then
        raise exception 'A decision reason is required';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Cancellation request was not found for an event assigned to this Coordinator';
    end if;

    update public.event_cancellation_requests
    set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
        decision_reason = btrim(p_reason),
        closed_by = auth.uid(),
        closed_at = now()
    where event_id = p_event_id and status = 'pending'
    returning * into current_request;

    if current_request.id is null then
        raise exception 'Cancellation request is no longer pending';
    end if;

    if p_decision = 'approve' then
        -- Cancelling also expires any other open request (trigger).
        update public.events
        set status = 'cancelled',
            updated_at = now(),
            registration_closes_at = coalesce(registration_closes_at, now())
        where id = p_event_id
        returning * into current_event;

        update public.venue_tentative_holds
        set released_at = coalesce(released_at, now())
        where event_id = p_event_id
          and released_at is null;

        delete from public.venue_blocks
        where source_booking_id in (
            select booking_id from public.venue_bookings where event_id = p_event_id
        )
        or booking_id in (
            select booking_id from public.venue_bookings where event_id = p_event_id
        );

        update public.venue_bookings
        set status = 'CANCELLED'
        where event_id = p_event_id
          and status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY');

        delete from public.equipment_bookings
        where request_id in (
            select id from public.equipment_requests where event_id = p_event_id
        );

        update public.equipment_requests
        set status = 'Cancelled'
        where event_id = p_event_id
          and status <> 'Cancelled';
    else
        update public.events
        set updated_at = now()
        where id = p_event_id
        returning * into current_event;
    end if;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'cancellation_request', to_jsonb(current_request)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Confirming and completing
-- ---------------------------------------------------------------------------

-- Show the open-request blocker on the planning readiness panel too, so the
-- Coordinator sees why Confirm is unavailable.
create or replace function public.event_planning_blockers(p_event_id uuid)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    blockers text[] := array[]::text[];
begin
    select * into current_event
    from public.events
    where id = p_event_id;

    if not found then
        return array['Event request was not found.']::text[];
    end if;

    if current_event.status <> 'planning' then
        blockers := array_append(
            blockers,
            'Only events in planning can be confirmed.'
        );
    end if;

    if public.event_has_open_requests(p_event_id) then
        blockers := array_append(
            blockers,
            'Close the open clarification, change or cancellation request before confirming this event.'
        );
    end if;

    if not exists (
        select 1
        from public.venue_bookings vb
        where vb.event_id = p_event_id
    ) then
        blockers := array_append(
            blockers,
            'Add at least one venue booking before confirming this event.'
        );
    elsif exists (
        select 1
        from public.venue_bookings vb
        where vb.event_id = p_event_id
          and upper(btrim(coalesce(vb.status, ''))) <> 'APPROVED'
    ) then
        blockers := array_append(
            blockers,
            'Every venue booking must be approved before confirming this event.'
        );
    end if;

    if nullif(btrim(current_event.equipment_requirements), '') is not null
       and not exists (
           select 1
           from public.equipment_requests er
           where er.event_id = p_event_id
       ) then
        blockers := array_append(
            blockers,
            'Technical requirements need an equipment request before confirmation.'
        );
    end if;

    if exists (
        select 1
        from public.equipment_requests er
        where er.event_id = p_event_id
          and upper(btrim(coalesce(er.status, ''))) <> 'APPROVED'
    ) then
        blockers := array_append(
            blockers,
            'Every equipment request must be approved before confirming this event.'
        );
    end if;

    if exists (
        select 1
        from public.equipment_requests er
        where er.event_id = p_event_id
          and not exists (
              select 1
              from public.equipment_request_items eri
              where eri.request_id = er.id
          )
    ) then
        blockers := array_append(
            blockers,
            'Approved equipment requests must include allocated equipment before confirmation.'
        );
    end if;

    return blockers;
end;
$$;

-- Only confirmed events complete. Anything still open on them expires
-- through the events_expire_open_requests trigger.
create or replace function public.complete_ended_events()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    candidate_id uuid;
    completion_time timestamptz := now();
    completed_count integer := 0;
begin
    for candidate_id in
        select id from public.events
        where status = 'confirmed' and end_time < completion_time
        order by id
    loop
        -- Skip an event another request is busy with; the next run picks it up.
        perform 1 from public.events
        where id = candidate_id and status = 'confirmed'
        for update skip locked;
        if not found then
            continue;
        end if;

        update public.events
        set status = 'completed',
            completed_at = coalesce(completed_at, completion_time),
            updated_at = completion_time
        where id = candidate_id;
        completed_count := completed_count + 1;
    end loop;
    -- Scalar result cannot be truncated by the Data API row limit.
    return completed_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Coordinator update policy
-- ---------------------------------------------------------------------------

-- Coordinators update the status directly when accepting or rejecting. The
-- side-request statuses are gone, so drop them from the policy.
drop policy if exists "Coordinators can decide their assigned reviewable events" on public.events;
create policy "Coordinators can decide their assigned reviewable events"
on public.events
for update
to authenticated
using (
    public.is_coordinator()
    and coordinator_id = (select auth.uid())
    and status in ('under_review', 'planning')
)
with check (
    public.is_coordinator()
    and coordinator_id = (select auth.uid())
    and status in ('planning', 'rejected')
);

commit;
