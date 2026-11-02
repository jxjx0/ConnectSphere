-- Trackable equipment requests.
--
-- A Coordinator now asks for quantities of a kind of equipment ("Projector
-- x 2", with optional specifics) rather than describing it all in text, so
-- the system can count what has been allocated and what is left.
--
--   * equipment.type now says the kind an item counts as, so "Old Projector"
--     and "Projector" are both a Projector. It replaces the broad Audio, Visual
--     and Staging values, which nothing in this workflow uses.
--   * equipment_request_lines holds what was asked for. A line's item_name is
--     matched to equipment.type, so something not in the catalogue yet can be
--     requested, and is allocated once an item of that type exists.
--   * equipment_bookings.line_id says which line an allocation counts towards.
--     The booking function fills it in, so every way of booking is counted.
--   * A request with lines cannot be approved until every line is full.
--
-- The Organiser's free-text equipment needs on a session are not changed.
-- Requests from before this keep working: those with old item rows get lines
-- here, and those that are text only still need just one allocation.
--
-- Requires: equipment_bookings.sql, equipment_requests.sql and
-- equipment_request_workflow.sql. Apply this before deploying the code that
-- uses it: the app reads the new table and column.

begin;

-- ---------------------------------------------------------------------------
-- 1. Equipment types
-- ---------------------------------------------------------------------------

-- Before this, the live catalogue's types were: Audio for Audio Mixer, Speaker
-- and Wireless Microphone; Visual for Old Projector, Projector and Visualiser.
update public.equipment set type = btrim(name);
update public.equipment set type = 'Projector' where name = 'Old Projector';

-- An item with no type of its own counts as its name.
create function public.default_equipment_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.type := coalesce(nullif(btrim(new.type), ''), btrim(new.name));
    return new;
end;
$$;

create trigger equipment_default_type
before insert or update on public.equipment
for each row
execute function public.default_equipment_type();

-- ---------------------------------------------------------------------------
-- 2. Request lines
-- ---------------------------------------------------------------------------

create table public.equipment_request_lines (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null references public.equipment_requests(id) on delete cascade,
    item_name text not null,
    quantity integer not null,
    specifics text,
    constraint equipment_request_lines_item_name_not_blank
        check (length(btrim(item_name)) between 1 and 120),
    constraint equipment_request_lines_quantity_positive
        check (quantity between 1 and 100),
    constraint equipment_request_lines_specifics_length
        check (specifics is null or length(specifics) <= 500)
);

create unique index equipment_request_lines_one_per_item
    on public.equipment_request_lines (request_id, lower(item_name));

alter table public.equipment_request_lines enable row level security;

create policy "Coordinators and Tech Support can view request lines"
on public.equipment_request_lines
for select
to authenticated
using (
    exists (
        select 1
        from public.equipment_requests as equipment_request
        where equipment_request.id = equipment_request_lines.request_id
          and (
              public.is_tech_support()
              or (public.is_coordinator() and exists (
                  select 1
                  from public.events as event
                  where event.id = equipment_request.event_id
                    and event.coordinator_id = (select auth.uid())
              ))
          )
    )
);

revoke all on public.equipment_request_lines from public, anon, authenticated;
grant select on public.equipment_request_lines to authenticated;

alter table public.equipment_bookings
    add column line_id uuid references public.equipment_request_lines(id) on delete set null;

-- Requests that listed specific items become lines for those items' types.
insert into public.equipment_request_lines (request_id, item_name, quantity)
select item.request_id, min(equipment.type), least(sum(item.quantity), 100)::integer
from public.equipment_request_items as item
join public.equipment as equipment on equipment.id = item.equipment_id
group by item.request_id, lower(equipment.type);

update public.equipment_bookings as booking
set line_id = line.id
from public.equipment_request_lines as line, public.equipment as equipment
where line.request_id = booking.request_id
  and equipment.id = booking.equipment_id
  and lower(line.item_name) = lower(equipment.type);

-- ---------------------------------------------------------------------------
-- 3. Submitting a request as lines
-- ---------------------------------------------------------------------------

create function public.submit_equipment_request_lines(
    p_event_id uuid,
    p_session_id uuid,
    p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_request_id uuid;
    summary text;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_event_id is null
       or p_session_id is null
       or jsonb_typeof(p_lines) is distinct from 'array'
       or jsonb_array_length(p_lines) = 0 then
        raise exception 'Select a session and add the equipment needed.'
            using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(873204, hashtext(p_session_id::text));

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

    if not exists (
        select 1
        from public.event_sessions
        where id = p_session_id
          and event_id = p_event_id
    ) then
        raise exception 'The session does not belong to this event.'
            using errcode = '22023';
    end if;

    if exists (
        select 1
        from public.equipment_requests
        where session_id = p_session_id
          and status <> 'Cancelled'
    ) then
        raise exception 'An equipment request has already been submitted for this session.'
            using errcode = 'P0001';
    end if;

    -- A summary keeps every page that shows a request's description working.
    select string_agg(
        format(
            '%s x %s%s',
            line.quantity,
            btrim(line.item_name),
            coalesce(' (' || nullif(btrim(line.specifics), '') || ')', '')
        ),
        '; '
    )
    into summary
    from jsonb_to_recordset(p_lines) as line(item_name text, quantity integer, specifics text);

    insert into public.equipment_requests (
        event_id,
        session_id,
        coordinator_id,
        request_details
    )
    values (p_event_id, p_session_id, auth.uid(), summary)
    returning id into new_request_id;

    -- The table's constraints reject a blank name, a bad quantity or a repeat.
    insert into public.equipment_request_lines (request_id, item_name, quantity, specifics)
    select
        new_request_id,
        btrim(line.item_name),
        line.quantity,
        nullif(btrim(line.specifics), '')
    from jsonb_to_recordset(p_lines) as line(item_name text, quantity integer, specifics text);

    return new_request_id;
end;
$$;

revoke all on function public.submit_equipment_request_lines(uuid, uuid, jsonb) from public, anon;
grant execute on function public.submit_equipment_request_lines(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Booking counts towards a line
-- ---------------------------------------------------------------------------

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
        select *
        into line
        from public.equipment_request_lines
        where request_id = current_request.id
          and lower(item_name) = lower(equipment_kind);

        if not found then
            raise exception '% is not part of this request.', equipment_name
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

-- ---------------------------------------------------------------------------
-- 5. Approval needs every line full
-- ---------------------------------------------------------------------------

create or replace function public.review_equipment_request(p_request_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.equipment_requests%rowtype;
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
    set status = p_decision
    where id = current_request.id;

    return jsonb_build_object(
        'id', current_request.id,
        'status', p_decision
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Technical Support's queue includes the lines
-- ---------------------------------------------------------------------------

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
