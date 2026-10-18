-- Apply after equipment_request_review.sql.
-- Technical Support books specific equipment items for a request by hand.
-- Reviewing a request only changes its status; availability is decided by
-- these bookings, and the exclusion constraint stops any item being booked
-- twice for overlapping times.

create extension if not exists btree_gist with schema extensions;

create table if not exists public.equipment_bookings (
    id uuid primary key default gen_random_uuid(),
    equipment_id uuid not null references public.equipment(id) on delete restrict,
    request_id uuid not null references public.equipment_requests(id) on delete cascade,
    start_at timestamptz not null,
    end_at timestamptz not null,
    created_by uuid not null default auth.uid() references public.profiles(id),
    created_at timestamptz not null default now(),
    constraint equipment_bookings_time_order check (end_at > start_at),
    constraint equipment_bookings_no_overlap exclude using gist (
        equipment_id with =,
        tstzrange(start_at, end_at, '[)') with &&
    )
);

create index if not exists equipment_bookings_request_id_idx
    on public.equipment_bookings (request_id);

alter table public.equipment_bookings enable row level security;

revoke all on public.equipment_bookings from anon, authenticated;
grant select, insert, delete on public.equipment_bookings to authenticated;

drop policy if exists "Technical Support can view equipment bookings"
    on public.equipment_bookings;
create policy "Technical Support can view equipment bookings"
    on public.equipment_bookings for select
    to authenticated
    using (public.is_tech_support());

drop policy if exists "Technical Support can add equipment bookings"
    on public.equipment_bookings;
create policy "Technical Support can add equipment bookings"
    on public.equipment_bookings for insert
    to authenticated
    with check (public.is_tech_support() and created_by = auth.uid());

drop policy if exists "Technical Support can remove equipment bookings"
    on public.equipment_bookings;
create policy "Technical Support can remove equipment bookings"
    on public.equipment_bookings for delete
    to authenticated
    using (public.is_tech_support());

-- Bookings for one item in a time range, with the event each one is for,
-- for the catalogue's month calendar.
create or replace function public.list_equipment_bookings(
    p_equipment_id uuid,
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

    return coalesce((
        select jsonb_agg(
            jsonb_build_object(
                'id', booking.id,
                'equipment_id', booking.equipment_id,
                'request_id', booking.request_id,
                'request_status', equipment_request.status,
                'event_id', event.id,
                'event_name', event.name,
                'start_at', booking.start_at,
                'end_at', booking.end_at
            )
            order by booking.start_at
        )
        from public.equipment_bookings as booking
        join public.equipment_requests as equipment_request
          on equipment_request.id = booking.request_id
        join public.events as event on event.id = equipment_request.event_id
        where booking.equipment_id = p_equipment_id
          and booking.start_at < p_to
          and booking.end_at > p_from
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_equipment_bookings(uuid, timestamptz, timestamptz)
    from public, anon;
grant execute on function public.list_equipment_bookings(uuid, timestamptz, timestamptz)
    to authenticated;

-- The queue no longer computes availability; it lists each request's
-- equipment bookings instead.
-- An event's technical requirement is outstanding while any of its requests
-- is still waiting for review; rejected requests are closed decisions.
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
                      and outstanding_request.status = 'Pending Technical Approval'
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
                            'id', booking.id,
                            'equipment_id', equipment.id,
                            'equipment_name', equipment.name,
                            'start_at', booking.start_at,
                            'end_at', booking.end_at
                        )
                        order by booking.start_at, equipment.name
                    )
                    from public.equipment_bookings as booking
                    join public.equipment as equipment
                      on equipment.id = booking.equipment_id
                    where booking.request_id = equipment_request.id
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

-- Approve and reject only record the decision. Rejecting frees any
-- equipment already booked for the request.
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
