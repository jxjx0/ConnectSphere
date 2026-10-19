-- Apply after equipment_bookings.sql.
-- Keeps one text-described equipment request per event and requires Technical
-- Support to allocate at least one catalogue item before approving it.

alter table public.equipment_requests
    add column if not exists request_details text;

update public.equipment_requests as equipment_request
set request_details = coalesce(
    nullif(btrim(event.equipment_requirements), ''),
    'No description was provided for this existing request.'
)
from public.events as event
where event.id = equipment_request.event_id
  and equipment_request.request_details is null;

alter table public.equipment_requests
    alter column request_details set not null;

-- Request status changes must go through the guarded review function.
revoke update on public.equipment_requests from authenticated;
revoke update (status) on public.equipment_requests from authenticated;
drop policy if exists "Technical Support can review equipment requests"
    on public.equipment_requests;

-- Earlier versions allowed status approval without any allocation. Restore
-- those requests to the actionable pending state instead of showing a false
-- approval.
update public.equipment_requests as equipment_request
set status = 'Pending Technical Approval'
where equipment_request.status = 'Approved'
  and (
      not exists (
          select 1
          from public.equipment_request_items as request_item
          where request_item.request_id = equipment_request.id
      )
      or exists (
          select 1
          from public.equipment_request_items as request_item
          where request_item.request_id = equipment_request.id
            and not exists (
                select 1
                from public.equipment_bookings as booking
                where booking.request_id = equipment_request.id
                  and booking.equipment_id = request_item.equipment_id
                  and booking.start_at <= (
                      select min(event_window.start_at)
                      from public.equipment_request_time_windows(equipment_request.event_id) as event_window
                  )
                  and booking.end_at >= (
                      select max(event_window.end_at)
                      from public.equipment_request_time_windows(equipment_request.event_id) as event_window
                  )
            )
      )
  );

-- A request is created by the assigned Coordinator after reviewing the
-- Organiser's event request. The advisory lock serializes competing attempts
-- for the same event without adding a schema object.
drop function if exists public.submit_equipment_request(uuid, jsonb);

create or replace function public.submit_equipment_request(
    p_event_id uuid,
    p_items jsonb,
    p_request_details text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_request_id uuid;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_event_id is null
       or p_request_details is null
       or length(btrim(p_request_details)) = 0
       or p_items is null
       or jsonb_typeof(p_items) is distinct from 'array'
       then
        raise exception 'Select an event and describe the equipment needed.'
            using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(873204, hashtext(p_event_id::text));

    if exists (
        select 1
        from public.equipment_requests
        where event_id = p_event_id
    ) then
        raise exception 'An equipment request has already been submitted for this event.'
            using errcode = 'P0001';
    end if;

    if not exists (
        select 1
        from public.events
        where id = p_event_id
          and coordinator_id = auth.uid()
          and status in ('planning', 'confirmed')
    ) then
        raise exception 'Event not found, not assigned to you, or not eligible for an equipment request.'
            using errcode = 'P0002';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        where item.equipment_id is null
           or item.quantity is null
           or item.quantity <= 0
    ) then
        raise exception 'Every requested equipment item must have a positive quantity.'
            using errcode = '22023';
    end if;

    if exists (
        select equipment_id
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        group by equipment_id
        having count(*) > 1
    ) then
        raise exception 'Each equipment item can only be listed once.'
            using errcode = '23505';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        left join public.equipment as equipment
          on equipment.id = item.equipment_id
        where equipment.id is null
           or equipment.maintenance_status <> 'Functional'
    ) then
        raise exception 'Requested equipment must exist and be functional.'
            using errcode = '23503';
    end if;

    insert into public.equipment_requests (
        event_id,
        coordinator_id,
        request_details
    )
    values (p_event_id, auth.uid(), btrim(p_request_details))
    returning id into new_request_id;

    insert into public.equipment_request_items (request_id, equipment_id, quantity)
    select new_request_id, item.equipment_id, item.quantity
    from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer);

    return new_request_id;
end;
$$;

revoke all on function public.submit_equipment_request(uuid, jsonb, text) from public;
grant execute on function public.submit_equipment_request(uuid, jsonb, text)
    to authenticated;

-- RLS remains the read boundary; all booking writes go through the guarded
-- functions below so request state and event windows are checked atomically.
revoke insert, delete on public.equipment_bookings from authenticated;
drop policy if exists "Technical Support can add equipment bookings"
    on public.equipment_bookings;
drop policy if exists "Technical Support can remove equipment bookings"
    on public.equipment_bookings;

drop policy if exists "Coordinators can view bookings for assigned events"
    on public.equipment_bookings;
create policy "Coordinators can view bookings for assigned events"
    on public.equipment_bookings
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.equipment_requests as equipment_request
            join public.events as event
              on event.id = equipment_request.event_id
            where equipment_request.id = request_id
              and public.is_coordinator()
              and event.coordinator_id = auth.uid()
        )
    );

create or replace function public.list_all_equipment_bookings(
    p_from timestamptz,
    p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can view equipment bookings.'
            using errcode = '42501';
    end if;

    if p_from is null or p_to is null or p_to <= p_from then
        raise exception 'The calendar end time must be after its start time.'
            using errcode = '22023';
    end if;

    return coalesce((
        select jsonb_agg(
            jsonb_build_object(
                'id', booking.id,
                'equipment_id', equipment.id,
                'equipment_name', equipment.name,
                'equipment_type', equipment.type,
                'request_id', equipment_request.id,
                'request_status', equipment_request.status,
                'event_id', event.id,
                'event_name', event.name,
                'start_at', booking.start_at,
                'end_at', booking.end_at
            )
            order by booking.start_at, equipment.name, event.name
        )
        from public.equipment_bookings as booking
        join public.equipment as equipment
          on equipment.id = booking.equipment_id
        join public.equipment_requests as equipment_request
          on equipment_request.id = booking.request_id
        join public.events as event
          on event.id = equipment_request.event_id
        where booking.start_at < p_to
          and booking.end_at > p_from
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_all_equipment_bookings(timestamptz, timestamptz)
    from public, anon;
grant execute on function public.list_all_equipment_bookings(timestamptz, timestamptz)
    to authenticated;

create or replace function public.create_equipment_booking(
    p_equipment_id uuid,
    p_request_id uuid,
    p_start_at timestamptz,
    p_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.equipment_requests%rowtype;
    equipment_name text;
    equipment_maintenance_status text;
    event_name text;
    schedule_start timestamptz;
    schedule_end timestamptz;
    new_booking public.equipment_bookings%rowtype;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can book equipment.'
            using errcode = '42501';
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
        raise exception 'Only pending equipment requests can be allocated.'
            using errcode = 'P0001';
    end if;

    select equipment.name, equipment.maintenance_status
    into equipment_name, equipment_maintenance_status
    from public.equipment as equipment
    where equipment.id = p_equipment_id
    for update;

    if not found then
        raise exception 'The requested equipment was not found.'
            using errcode = '23503';
    end if;

    if exists (
        select 1
        from public.equipment_bookings as booking
        where booking.request_id = current_request.id
          and booking.equipment_id = p_equipment_id
    ) then
        raise exception 'This requested item has already been allocated.'
            using errcode = 'P0001';
    end if;

    select min(event_window.start_at), max(event_window.end_at)
    into schedule_start, schedule_end
    from public.equipment_request_time_windows(current_request.event_id) as event_window;

    if schedule_start is null or p_start_at is null or p_end_at is null
       or p_end_at <= p_start_at
       or p_start_at is distinct from schedule_start
       or p_end_at is distinct from schedule_end then
        raise exception 'Allocate equipment for the full event time, including venue setup and teardown buffers.'
            using errcode = '22023';
    end if;

    select event.name
    into event_name
    from public.events as event
    where event.id = current_request.event_id;

    if equipment_maintenance_status <> 'Functional' then
        return jsonb_build_object(
            'outcome', 'unavailable',
            'reason', 'maintenance',
            'equipment_status', equipment_maintenance_status,
            'coordinator_id', current_request.coordinator_id,
            'event_id', current_request.event_id,
            'event_name', event_name,
            'equipment_name', equipment_name
        );
    end if;

    begin
        insert into public.equipment_bookings (
            equipment_id,
            request_id,
            start_at,
            end_at,
            created_by
        )
        values (
            p_equipment_id,
            current_request.id,
            p_start_at,
            p_end_at,
            auth.uid()
        )
        returning * into new_booking;
    exception
        when exclusion_violation then
            return jsonb_build_object(
                'outcome', 'unavailable',
                'reason', 'overlap',
                'coordinator_id', current_request.coordinator_id,
                'event_id', current_request.event_id,
                'event_name', event_name,
                'equipment_name', equipment_name
            );
    end;

    insert into public.equipment_request_items (
        request_id,
        equipment_id,
        quantity
    )
    values (current_request.id, p_equipment_id, 1)
    on conflict (request_id, equipment_id) do nothing;

    return jsonb_build_object(
        'outcome', 'booked',
        'booking', jsonb_build_object(
            'id', new_booking.id,
            'equipment_id', new_booking.equipment_id,
            'request_id', new_booking.request_id,
            'start_at', new_booking.start_at,
            'end_at', new_booking.end_at
        )
    );
end;
$$;

revoke all on function public.create_equipment_booking(uuid, uuid, timestamptz, timestamptz)
    from public;
grant execute on function public.create_equipment_booking(uuid, uuid, timestamptz, timestamptz)
    to authenticated;

create or replace function public.delete_equipment_booking(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    booking_request_id uuid;
    request_status text;
    removed_equipment_id uuid;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can remove equipment bookings.'
            using errcode = '42501';
    end if;

    select request.id, request.status
    into booking_request_id, request_status
    from public.equipment_bookings as booking
    join public.equipment_requests as request
      on request.id = booking.request_id
    where booking.id = p_booking_id
    for update of request;

    if not found then
        return false;
    end if;

    if request_status <> 'Pending Technical Approval' then
        raise exception 'Equipment allocated to an approved request cannot be removed.'
            using errcode = 'P0001';
    end if;

    delete from public.equipment_bookings
    where id = p_booking_id
    returning equipment_id into removed_equipment_id;

    delete from public.equipment_request_items
    where request_id = booking_request_id
      and equipment_id = removed_equipment_id
      and not exists (
          select 1
          from public.equipment_bookings
          where request_id = booking_request_id
            and equipment_id = removed_equipment_id
      );

    return true;
end;
$$;

revoke all on function public.delete_equipment_booking(uuid) from public;
grant execute on function public.delete_equipment_booking(uuid)
    to authenticated;

-- Keep the coordinator's event status truthful and retain booking details in
-- the review queue. The request status itself replaces the old vague flag.
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
                'request_details', equipment_request.request_details,
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
    requested_item_count integer;
    allocated_item_count integer;
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
        delete from public.equipment_bookings
        where request_id = current_request.id;
    else
        select count(*)
        into requested_item_count
        from public.equipment_request_items
        where request_id = current_request.id;

        select count(distinct request_item.equipment_id)
        into allocated_item_count
        from public.equipment_request_items as request_item
        join public.equipment_bookings as booking
          on booking.request_id = request_item.request_id
         and booking.equipment_id = request_item.equipment_id
        where request_item.request_id = current_request.id;

        if requested_item_count = 0 or allocated_item_count <> requested_item_count then
            raise exception 'Allocate every requested equipment item before approving this request.'
                using errcode = 'P0001';
        end if;

        if exists (
            select 1
            from public.equipment_request_items as request_item
            join public.equipment_bookings as booking
              on booking.request_id = request_item.request_id
             and booking.equipment_id = request_item.equipment_id
            where request_item.request_id = current_request.id
              and (
                  booking.start_at > (
                      select min(event_window.start_at)
                      from public.equipment_request_time_windows(current_request.event_id) as event_window
                  )
                  or booking.end_at < (
                      select max(event_window.end_at)
                      from public.equipment_request_time_windows(current_request.event_id) as event_window
                  )
              )
        ) then
            raise exception 'Allocated equipment must cover the full event time, including venue setup and teardown buffers.'
                using errcode = 'P0001';
        end if;
    end if;

    update public.equipment_requests
    set status = p_decision
    where id = current_request.id;

    return jsonb_build_object(
        'id', current_request.id,
        'status', p_decision
    );
end;
$$;

revoke all on function public.review_equipment_request(uuid, text) from public;
grant execute on function public.review_equipment_request(uuid, text)
    to authenticated;
