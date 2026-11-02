-- Local proposal only. Apply separately as the trusted database owner with
-- CREATEROLE/admin privileges. venue_private stays outside exposed API schemas.
begin;

-- The helper owner inherits authenticated's booking policies/grants, but is
-- neither the booking table owner nor a BYPASSRLS role. Application roles must
-- never be members of this owner role (membership below goes the other way).
do $$
begin
    if pg_catalog.to_regnamespace('venue_private') is null then
        create schema venue_private;
    end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'venue_booking_name_reader') then
        create role venue_booking_name_reader nologin inherit nobypassrls;
    end if;
    if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'venue_booking_name_reader'
          and (rolsuper or rolbypassrls or rolcanlogin or rolcreaterole or rolcreatedb or rolreplication or not rolinherit)
    ) or exists (
        select 1 from pg_catalog.pg_roles r
        where r.rolname in ('anon', 'authenticated', 'authenticator')
          and pg_catalog.pg_has_role(r.oid, 'venue_booking_name_reader', 'MEMBER')
    ) then
        raise exception 'Unsafe venue_booking_name_reader role configuration.';
    end if;
    -- Only the trusted installer may assume the function owner for maintenance.
    execute pg_catalog.format('grant venue_booking_name_reader to %I', current_user);
end;
$$;
revoke all on schema venue_private from public, anon;
grant usage on schema venue_private to authenticated;
grant authenticated to venue_booking_name_reader;

-- This owner-privileged view is the sole event/session RLS bypass. It exposes
-- only names indexed by booking ID, exclusively to the non-login helper owner.
-- No SELECT grant or RLS policy on events/event_sessions is added or changed.
create or replace view venue_private.venue_booking_name_projection
with (security_barrier = true) as
select b.booking_id, e.name::text as event_name, s.name::text as session_name
from public.venue_bookings b
join public.events e on e.id = b.event_id
left join public.event_sessions s on s.id = b.session_id and s.event_id = b.event_id
where b.status = 'PENDING_VENUE_APPROVAL';
revoke all on venue_private.venue_booking_name_projection from public, anon, authenticated;
grant select on venue_private.venue_booking_name_projection to venue_booking_name_reader;

create or replace function venue_private.get_venue_booking_event_names(p_booking_ids uuid[])
returns table (booking_id uuid, event_name text, session_name text)
language plpgsql stable security definer
set search_path = ''
set row_security = on
as $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can read booking names.' using errcode = '42501';
    end if;

    -- Fail closed if ownership/grants drift or booking RLS is disabled.
    if not pg_catalog.row_security_active('public.venue_bookings'::pg_catalog.regclass) then
        raise exception 'Booking row security must be active.' using errcode = '42501';
    end if;

    return query
    select b.booking_id, n.event_name, n.session_name
    from public.venue_bookings b
    join venue_private.venue_booking_name_projection n on n.booking_id = b.booking_id
    where b.booking_id = any(p_booking_ids)
      and b.status = 'PENDING_VENUE_APPROVAL';
end;
$$;

-- The temporary schema privilege is needed for ALTER FUNCTION OWNER.
grant create on schema venue_private to venue_booking_name_reader;
alter function venue_private.get_venue_booking_event_names(uuid[]) owner to venue_booking_name_reader;
revoke create on schema venue_private from venue_booking_name_reader;

-- Every entry point delegates to the helper's own booking-RLS enforcement.
create or replace function public.get_venue_booking_event_names(p_booking_ids uuid[])
returns table (booking_id uuid, event_name text, session_name text)
language sql stable security invoker
set search_path = ''
as $$
    select n.booking_id, n.event_name, n.session_name
    from venue_private.get_venue_booking_event_names(p_booking_ids) n;
$$;

revoke all on function venue_private.get_venue_booking_event_names(uuid[]) from public, anon;
revoke all on function public.get_venue_booking_event_names(uuid[]) from public, anon;
grant execute on function venue_private.get_venue_booking_event_names(uuid[]) to authenticated;
grant execute on function public.get_venue_booking_event_names(uuid[]) to authenticated;

commit;
