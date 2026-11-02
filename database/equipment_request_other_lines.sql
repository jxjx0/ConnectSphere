-- Lets Technical Support fill an "Other" line with an existing item.
--
-- An "Other" line asks for something the catalogue has no item of, such as a
-- Fog machine. Technical Support can now allocate a similar item they already
-- have by naming the line. The item's own type does not change. Lines for a
-- type the catalogue does have stay strict, so their counts stay reliable.
--
-- Requires: equipment_request_lines.sql. Apply this before deploying the code
-- that uses it. The old code keeps working, as the new argument is optional.

begin;

drop function public.create_equipment_booking(uuid, uuid, timestamptz, timestamptz);

create or replace function public.create_equipment_booking(
    p_equipment_id uuid,
    p_request_id uuid,
    p_start_at timestamptz,
    p_end_at timestamptz,
    p_line_id uuid default null
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
    equipment_kind text;
    event_name text;
    schedule_start timestamptz;
    schedule_end timestamptz;
    new_booking public.equipment_bookings%rowtype;
    line public.equipment_request_lines%rowtype;
    has_lines boolean;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can book equipment.'
            using errcode = '42501';
    end if;

    -- This lock also keeps two allocations from overfilling a line.
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

    select equipment.name, equipment.maintenance_status, equipment.type
    into equipment_name, equipment_maintenance_status, equipment_kind
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

    has_lines := exists (
        select 1
        from public.equipment_request_lines
        where request_id = current_request.id
    );

    if has_lines then
        if p_line_id is null then
            select *
            into line
            from public.equipment_request_lines
            where request_id = current_request.id
              and lower(item_name) = lower(equipment_kind);
        else
            select *
            into line
            from public.equipment_request_lines
            where request_id = current_request.id
              and id = p_line_id;
        end if;

        if not found then
            raise exception '% is not part of this request.', equipment_name
                using errcode = 'EQ001';
        end if;

        -- A different item can only stand in for something the catalogue lacks.
        if lower(line.item_name) <> lower(equipment_kind) and exists (
            select 1
            from public.equipment as equipment
            where lower(equipment.type) = lower(line.item_name)
        ) then
            raise exception '% is not a %, so it cannot fill this line.', equipment_name, line.item_name
                using errcode = 'EQ001';
        end if;

        if (
            select count(*)
            from public.equipment_bookings
            where line_id = line.id
        ) >= line.quantity then
            raise exception 'All % of % have already been allocated.', line.quantity, line.item_name
                using errcode = 'EQ001';
        end if;
    end if;

    select min(request_window.start_at), max(request_window.end_at)
    into schedule_start, schedule_end
    from public.equipment_request_window(current_request.id) as request_window;

    if schedule_start is null or p_start_at is null or p_end_at is null
       or p_end_at <= p_start_at
       or p_start_at is distinct from schedule_start
       or p_end_at is distinct from schedule_end then
        if current_request.session_id is null then
            raise exception 'Allocate equipment for the full event time, including venue setup and teardown buffers.'
                using errcode = '22023';
        end if;
        raise exception 'Allocate equipment for the full session time.'
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
            line_id,
            start_at,
            end_at,
            created_by
        )
        values (
            p_equipment_id,
            current_request.id,
            line.id,
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

    return jsonb_build_object(
        'outcome', 'booked',
        'booking', jsonb_build_object(
            'id', new_booking.id,
            'equipment_id', new_booking.equipment_id,
            'request_id', new_booking.request_id,
            'line_id', new_booking.line_id,
            'start_at', new_booking.start_at,
            'end_at', new_booking.end_at
        )
    );
end;
$$;

revoke all on function public.create_equipment_booking(uuid, uuid, timestamptz, timestamptz, uuid)
    from public, anon;
grant execute on function public.create_equipment_booking(uuid, uuid, timestamptz, timestamptz, uuid)
    to authenticated;

commit;
