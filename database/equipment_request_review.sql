-- Apply after equipment_request_hardening.sql.
-- Approved requests act as time-limited equipment reservations; no tables or
-- equipment catalogue maintenance fields are changed by this workflow.

-- Reviews must go through the atomic function below so direct table updates
-- cannot bypass the time-window availability check.
revoke update on public.equipment_requests from authenticated;
revoke update (status) on public.equipment_requests from authenticated;
drop policy if exists "Technical Support can review equipment requests"
    on public.equipment_requests;

create or replace function public.equipment_request_time_windows(
    p_event_id uuid
)
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
security definer
set search_path = ''
as $$
    select
        booking.booking_id,
        venue.name,
        booking.room_layout::text,
        booking.effective_start_at,
        booking.effective_end_at,
        booking.status::text
    from public.venue_bookings as booking
    join public.venues as venue on venue.id = booking.venue_id
    where booking.event_id = p_event_id
      and upper(booking.status) not in ('REJECTED', 'CANCELLED')
      and booking.effective_start_at < booking.effective_end_at

    union all

    select
        null::uuid,
        null::text,
        null::text,
        event.start_time,
        event.end_time,
        'EVENT_SCHEDULE'::text
    from public.events as event
    where event.id = p_event_id
      and event.start_time is not null
      and event.end_time > event.start_time
      and not exists (
          select 1
          from public.venue_bookings as booking
          where booking.event_id = p_event_id
            and upper(booking.status) not in ('REJECTED', 'CANCELLED')
            and booking.effective_start_at < booking.effective_end_at
      );
$$;

revoke all on function public.equipment_request_time_windows(uuid) from public;

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
                'coordinator_id', equipment_request.coordinator_id,
                'status', equipment_request.status,
                'technical_requirement_outstanding', exists (
                    select 1
                    from public.equipment_requests as outstanding_request
                    where outstanding_request.event_id = event.id
                      and outstanding_request.status <> 'Approved'
                ),
                'created_at', equipment_request.created_at,
                'event', jsonb_build_object(
                    'id', event.id,
                    'name', event.name,
                    'start_time', event.start_time,
                    'end_time', event.end_time,
                    'organiser_name', organiser.full_name
                ),
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
                    from public.equipment_request_time_windows(event.id) as booking_window
                ), '[]'::jsonb),
                'items', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', request_item.id,
                            'equipment_id', equipment.id,
                            'quantity', request_item.quantity,
                            'available',
                                equipment_request.status = 'Pending Technical Approval'
                                and equipment.maintenance_status = 'Functional'
                                and exists (
                                    select 1
                                    from public.equipment_request_time_windows(event.id)
                                )
                                and not exists (
                                    select 1
                                    from public.equipment_requests as reserved_request
                                    join public.equipment_request_items as reserved_item
                                      on reserved_item.request_id = reserved_request.id
                                    cross join lateral
                                      public.equipment_request_time_windows(reserved_request.event_id)
                                      as reserved_window
                                    cross join lateral
                                      public.equipment_request_time_windows(event.id)
                                      as requested_window
                                    where reserved_request.status = 'Approved'
                                      and reserved_request.id <> equipment_request.id
                                      and reserved_item.equipment_id = equipment.id
                                      and reserved_window.start_at < requested_window.end_at
                                      and reserved_window.end_at > requested_window.start_at
                                ),
                            'reserved', equipment_request.status = 'Approved',
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
                ), '[]'::jsonb)
            ) as request_data
        from public.equipment_requests as equipment_request
        join public.events as event on event.id = equipment_request.event_id
        join public.profiles as organiser on organiser.id = event.organiser_id
    ) as queue_row;

    return request_queue;
end;
$$;

revoke all on function public.list_equipment_request_review_queue() from public;
grant execute on function public.list_equipment_request_review_queue()
    to authenticated;

create or replace function public.review_equipment_request(
    p_request_id uuid,
    p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.equipment_requests%rowtype;
    unavailable_items jsonb;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can review equipment requests.'
            using errcode = '42501';
    end if;

    if p_decision is null or p_decision not in ('Approved', 'Rejected') then
        raise exception 'Decision must be Approved or Rejected.'
            using errcode = '22023';
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

    if p_decision = 'Rejected' then
        update public.equipment_requests
        set status = 'Rejected'
        where id = current_request.id;

        return jsonb_build_object(
            'outcome', 'reviewed',
            'request', jsonb_build_object(
                'id', current_request.id,
                'status', 'Rejected'
            )
        );
    end if;

    if not exists (
        select 1
        from public.equipment_request_items
        where request_id = current_request.id
    ) then
        raise exception 'Equipment request has no requested items.'
            using errcode = '22023';
    end if;

    perform equipment.id
    from public.equipment as equipment
    join public.equipment_request_items as request_item
      on request_item.equipment_id = equipment.id
    where request_item.request_id = current_request.id
    order by equipment.id
    for update of equipment;

    select coalesce(
        jsonb_agg(equipment.name order by equipment.name),
        '[]'::jsonb
    )
    into unavailable_items
    from public.equipment_request_items as request_item
    join public.equipment as equipment
      on equipment.id = request_item.equipment_id
    where request_item.request_id = current_request.id
      and (
          equipment.maintenance_status <> 'Functional'
          or not exists (
              select 1
              from public.equipment_request_time_windows(current_request.event_id)
          )
          or exists (
              select 1
              from public.equipment_requests as reserved_request
              join public.equipment_request_items as reserved_item
                on reserved_item.request_id = reserved_request.id
              cross join lateral
                public.equipment_request_time_windows(reserved_request.event_id)
                as reserved_window
              cross join lateral
                public.equipment_request_time_windows(current_request.event_id)
                as requested_window
              where reserved_request.status = 'Approved'
                and reserved_request.id <> current_request.id
                and reserved_item.equipment_id = equipment.id
                and reserved_window.start_at < requested_window.end_at
                and reserved_window.end_at > requested_window.start_at
          )
      );

    if jsonb_array_length(unavailable_items) > 0 then
        return jsonb_build_object(
            'outcome', 'unavailable',
            'request_id', current_request.id,
            'coordinator_id', current_request.coordinator_id,
            'event_id', current_request.event_id,
            'event_name', (
                select event.name
                from public.events as event
                where event.id = current_request.event_id
            ),
            'unavailable_items', unavailable_items
        );
    end if;

    update public.equipment_requests
    set status = 'Approved'
    where id = current_request.id;

    return jsonb_build_object(
        'outcome', 'reviewed',
        'request', jsonb_build_object(
            'id', current_request.id,
            'status', 'Approved'
        )
    );
end;
$$;

revoke all on function public.review_equipment_request(uuid, text) from public;
grant execute on function public.review_equipment_request(uuid, text)
    to authenticated;
