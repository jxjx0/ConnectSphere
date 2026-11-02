-- Technical Support gives a reason when rejecting an equipment request, as
-- Venue Staff do for venue bookings, and the Coordinator can see it.
--
-- Requests rejected before this, or released by a Safety Officer's rejection,
-- have no reason. Rejections through this function must have one.
--
-- Requires: equipment_request_lines.sql. Apply this just before deploying the
-- code that uses it, as older code rejects without a reason and will be refused.

begin;

alter table public.equipment_requests
    add column rejection_reason text;

drop function public.review_equipment_request(uuid, text);

create or replace function public.review_equipment_request(
    p_request_id uuid,
    p_decision text,
    p_rejection_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.equipment_requests%rowtype;
    reason text := nullif(btrim(p_rejection_reason), '');
    event_name text;
    session_name text;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can review equipment requests.'
            using errcode = '42501';
    end if;

    if p_decision is null or p_decision not in ('Approved', 'Rejected') then
        raise exception 'Decision must be Approved or Rejected.'
            using errcode = '22023';
    end if;

    if p_decision = 'Rejected' and (reason is null or length(reason) > 500) then
        raise exception 'Give a reason of up to 500 characters for rejecting this request.'
            using errcode = 'EQ001';
    end if;

    select *
    into current_request
    from public.equipment_requests
    where id = p_request_id
    for update;

    if not found then
        raise exception 'Equipment request was not found.'
            using errcode = 'P0002';
    end if;

    if current_request.status <> 'Pending Technical Approval' then
        raise exception 'This equipment request has already been reviewed.'
            using errcode = 'P0001';
    end if;

    if p_decision = 'Approved' and exists (
        select 1
        from public.equipment_request_lines as line
        where line.request_id = current_request.id
          and (
              select count(*)
              from public.equipment_bookings as booking
              where booking.line_id = line.id
          ) < line.quantity
    ) then
        raise exception 'Allocate all the requested equipment before approving this request.'
            using errcode = 'EQ001';
    end if;

    update public.equipment_requests
    set status = p_decision,
        rejection_reason = case when p_decision = 'Rejected' then reason end
    where id = current_request.id;

    select event.name into event_name
    from public.events as event
    where event.id = current_request.event_id;

    select session.name into session_name
    from public.event_sessions as session
    where session.id = current_request.session_id;

    -- The extra details let the backend tell the Coordinator.
    return jsonb_build_object(
        'id', current_request.id,
        'status', p_decision,
        'rejection_reason', case when p_decision = 'Rejected' then reason end,
        'coordinator_id', current_request.coordinator_id,
        'event_id', current_request.event_id,
        'event_name', event_name,
        'session_name', session_name
    );
end;
$$;

revoke all on function public.review_equipment_request(uuid, text, text) from public, anon;
grant execute on function public.review_equipment_request(uuid, text, text) to authenticated;

create or replace function public.list_equipment_request_review_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    request_queue jsonb;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can view equipment requests.'
            using errcode = '42501';
    end if;

    select coalesce(
        jsonb_agg(queue_row.request_data order by queue_row.status_order, queue_row.created_at desc),
        '[]'::jsonb
    )
    into request_queue
    from (
        select
            case
                when equipment_request.status = 'Pending Technical Approval' then 0
                else 1
            end as status_order,
            equipment_request.created_at,
            jsonb_build_object(
                'id', equipment_request.id,
                'event_id', event.id,
                'session_id', equipment_request.session_id,
                'coordinator_id', equipment_request.coordinator_id,
                'status', equipment_request.status,
                'request_details', equipment_request.request_details,
                'rejection_reason', equipment_request.rejection_reason,
                'created_at', equipment_request.created_at,
                'event', jsonb_build_object(
                    'id', event.id,
                    'name', event.name,
                    'start_time', event.start_time,
                    'end_time', event.end_time,
                    'organiser_name', organiser.full_name
                ),
                'session', case when session.id is null then null else jsonb_build_object(
                    'id', session.id,
                    'name', session.name,
                    'start_time', session.start_time,
                    'end_time', session.end_time,
                    'expected_attendance', session.expected_attendance,
                    'equipment_requirements', session.equipment_requirements
                ) end,
                'bookings', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'booking_id', booking_window.booking_id,
                            'venue_name', booking_window.venue_name,
                            'room_layout', booking_window.room_layout,
                            'start_at', booking_window.start_at,
                            'end_at', booking_window.end_at,
                            'booking_status', booking_window.booking_status
                        )
                        order by booking_window.start_at
                    )
                    from public.equipment_request_window(equipment_request.id) as booking_window
                ), '[]'::jsonb),
                'lines', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', line.id,
                            'item_name', line.item_name,
                            'quantity', line.quantity,
                            'specifics', line.specifics
                        )
                        order by line.item_name
                    )
                    from public.equipment_request_lines as line
                    where line.request_id = equipment_request.id
                ), '[]'::jsonb),
                'items', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', request_item.id,
                            'equipment_id', equipment.id,
                            'quantity', request_item.quantity,
                            'booked', exists (
                                select 1
                                from public.equipment_bookings as item_booking
                                where item_booking.request_id = equipment_request.id
                                  and item_booking.equipment_id = equipment.id
                            ),
                            'equipment', jsonb_build_object(
                                'id', equipment.id,
                                'name', equipment.name,
                                'type', equipment.type,
                                'maintenance_status', equipment.maintenance_status
                            )
                        )
                        order by equipment.name
                    )
                    from public.equipment_request_items as request_item
                    join public.equipment as equipment
                      on equipment.id = request_item.equipment_id
                    where request_item.request_id = equipment_request.id
                ), '[]'::jsonb),
                'equipment_bookings', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', item_booking.id,
                            'equipment_id', equipment.id,
                            'equipment_name', equipment.name,
                            'line_id', item_booking.line_id,
                            'start_at', item_booking.start_at,
                            'end_at', item_booking.end_at
                        )
                        order by item_booking.start_at, equipment.name
                    )
                    from public.equipment_bookings as item_booking
                    join public.equipment as equipment
                      on equipment.id = item_booking.equipment_id
                    where item_booking.request_id = equipment_request.id
                ), '[]'::jsonb)
            ) as request_data
        from public.equipment_requests as equipment_request
        join public.events as event
          on event.id = equipment_request.event_id
        join public.profiles as organiser
          on organiser.id = event.organiser_id
        left join public.event_sessions as session
          on session.id = equipment_request.session_id
        where (
            (
                nullif(btrim(equipment_request.request_details), '') is not null
                and equipment_request.request_details
                    <> 'No description was provided for this existing request.'
            )
            or exists (
                select 1
                from public.equipment_request_items as requested_item
                where requested_item.request_id = equipment_request.id
            )
        )
    ) as queue_row;

    return request_queue;
end;
$$;

commit;
