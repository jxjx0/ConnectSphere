-- Let Organisers request a change while their event awaits its safety check.
--
-- Approving a material change at that stage sends the event back to Planning,
-- as it does for a Confirmed event, so a Safety Officer never approves
-- arrangements that no longer match the event. Other changes leave the event
-- in the safety queue.
--
-- Requires: event_status_badges.sql (both functions are otherwise unchanged).

begin;

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

    if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
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

    -- A material change to a confirmed event, or one in its safety check,
    -- needs replanning and a new safety check.
    status_before := current_event.status;
    next_status := case
        when material and current_event.status in ('awaiting_safety_check', 'confirmed') then 'planning'
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
        'returned_to_planning', status_before <> next_status
    );
end;
$$;

commit;
