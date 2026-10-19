-- T7-38: apply after venues, events and venue_bookings exist.
-- Additive and repeatable; no booking/event writes or existing policy changes.
begin;

-- Keep privileged reads outside the schemas exposed by the Data API.
create schema if not exists venue_private;
revoke all on schema venue_private from public, anon;
grant usage on schema venue_private to authenticated;

create or replace function venue_private.get_venue_block_bookings(p_venue_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can check affected bookings.'
            using errcode = '42501';
    end if;

    -- One JSON value avoids PostgREST's row cap hiding affected bookings.
    -- event_id has no FK in the current booking schema: join it explicitly.
    -- A reassigned event must notify its CURRENT Coordinator, not its submitter.
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'booking_id', b.booking_id,
            'venue_id', b.venue_id,
            'venue_name', v.name,
            'event_id', b.event_id,
            'event_name', e.name,
            'coordinator_id', case when b.event_id is null
                then b.coordinator_id else e.coordinator_id end,
            'status', b.status,
            'start_at', b.start_at,
            'end_at', b.end_at,
            'setup_time_minutes', v.setup_time_minutes,
            'turnaround_time_minutes', v.turnaround_time_minutes
        ) order by b.booking_id), '[]'::jsonb)
        from public.venue_bookings b
        join public.venues v on v.id = b.venue_id
        left join public.events e on e.id = b.event_id
        where b.venue_id = p_venue_id and b.status = 'APPROVED'
    );
end;
$$;

revoke all on function venue_private.get_venue_block_bookings(uuid) from public, anon;
grant execute on function venue_private.get_venue_block_bookings(uuid) to authenticated;

-- Only the invoker wrapper is exposed; the private function checks auth + role.
create or replace function public.get_venue_block_bookings(p_venue_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select venue_private.get_venue_block_bookings(p_venue_id);
$$;

revoke all on function public.get_venue_block_bookings(uuid) from public, anon;
grant execute on function public.get_venue_block_bookings(uuid) to authenticated;

commit;
