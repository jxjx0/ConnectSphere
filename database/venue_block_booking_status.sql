-- Apply after venue_bookings, profiles and is_venue_staff() exist.
-- No table, RLS or approval-workflow changes. The new status fits VARCHAR(50).
begin;

-- One UPDATE is atomic. A JSON value avoids response row caps and large URL filters.
create or replace function public.mark_venue_block_bookings_affected(
    p_venue_id uuid, p_booking_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    updated_bookings jsonb;
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can update affected venue bookings.'
            using errcode = '42501';
    end if;

    with changed as (
            update public.venue_bookings
            set status = 'AFFECTED_BY_UNAVAILABILITY'
            where venue_id = p_venue_id
                and booking_id = any(p_booking_ids)
                and status = 'APPROVED'
            returning booking_id, status
        )
    select coalesce(jsonb_agg(to_jsonb(changed) order by booking_id), '[]'::jsonb)
    into updated_bookings from changed;
    return updated_bookings;
end;
$$;

revoke all on function public.mark_venue_block_bookings_affected(uuid, uuid[]) from public, anon;
grant execute on function public.mark_venue_block_bookings_affected(uuid, uuid[]) to authenticated;
commit;
