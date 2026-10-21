-- Apply after venues, profiles, events, venue_blocks, venue_bookings and
-- is_venue_staff(). Additive/repeatable; run manually, not the reference schemas.
begin;

create table if not exists public.venue_tentative_holds (
    hold_id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues(id),
    event_id uuid not null references public.events(id),
    start_at timestamptz not null,
    end_at timestamptz not null,
    expires_at timestamptz not null,
    created_by uuid not null references public.profiles(id),
    created_at timestamptz not null default now(),
    released_at timestamptz,
    completed_booking_id uuid references public.venue_bookings(booking_id),
    expiry_claimed_at timestamptz,
    expiry_notified_at timestamptz,
    constraint venue_hold_period check (start_at < end_at),
    constraint venue_hold_expiry check (created_at < expires_at and expires_at <= start_at)
);
create index if not exists venue_holds_live on public.venue_tentative_holds(venue_id, expires_at)
    where released_at is null;
drop index if exists public.venue_holds_due;
create index venue_holds_due on public.venue_tentative_holds(expires_at)
    where expiry_notified_at is null;
alter table public.venue_tentative_holds enable row level security;
revoke all on public.venue_tentative_holds from public, anon, authenticated, service_role;
grant select on public.venue_tentative_holds to authenticated;
drop policy if exists venue_hold_read on public.venue_tentative_holds;
create policy venue_hold_read on public.venue_tentative_holds for select to authenticated
    using (public.is_venue_staff() or exists (
        select 1 from public.events e where e.id = event_id and e.coordinator_id = (select auth.uid())
    ));

-- Tag only newly created booking reservations. Do not guess legacy provenance
-- from free-text reasons or rewrite existing operational blocks.
alter table public.venue_blocks add column if not exists source_booking_id uuid
    references public.venue_bookings(booking_id);
create index if not exists venue_blocks_booking on public.venue_blocks(source_booking_id);

create schema if not exists venue_private;
revoke all on schema venue_private from public, anon;
grant usage on schema venue_private to authenticated;

create or replace function venue_private.get_venue_hold_events()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can select hold events.' using errcode = '42501';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.start_time), '[]'::jsonb)
        from public.events e where e.coordinator_id is not null
        and e.status in ('under_review', 'planning', 'change_requested', 'confirmed') and e.end_time > now());
end; $$;

create or replace function venue_private.get_venue_reservations(
    p_venue_ids uuid[], p_exclude_event_id uuid default null, p_holds_only boolean default false
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role in ('venue_staff', 'coordinator')
    ) then
        raise exception 'Only venue staff and Coordinators can check reservations.' using errcode = '42501';
    end if;
    -- Coordinators may exclude only their own event; staff use this during approval.
    if p_exclude_event_id is not null and not public.is_venue_staff() and not exists (
        select 1 from public.events e where e.id = p_exclude_event_id and e.coordinator_id = auth.uid()
    ) then
        raise exception 'Event is not assigned to you.' using errcode = '42501';
    end if;
    if exists (select 1 from public.venue_tentative_holds h join public.venues v on v.id=h.venue_id
        where h.venue_id=any(p_venue_ids) and h.released_at is null and h.expires_at>now()
        and (v.setup_time_minutes is null or v.turnaround_time_minutes is null)) then
        raise exception 'Venue buffer configuration unavailable.' using errcode = '22023';
    end if;
    if not p_holds_only and exists (
        select 1 from public.venue_bookings b join public.venues v on v.id=b.venue_id
        where b.venue_id=any(p_venue_ids) and b.status in ('APPROVED','AFFECTED_BY_UNAVAILABILITY')
            and (v.setup_time_minutes is null or v.turnaround_time_minutes is null)
    ) then
        raise exception 'Venue buffer configuration unavailable.' using errcode = '22023';
    end if;
    return (select coalesce(jsonb_agg(to_jsonb(r) order by r.start_at, r.id), '[]'::jsonb) from (
        select b.booking_id as id, b.venue_id, 'confirmed_booking'::text as type,
            least(b.effective_start_at, b.start_at-make_interval(mins => greatest(v.setup_time_minutes,b.setup_buffer_minutes))) as start_at,
            greatest(b.effective_end_at, b.end_at+make_interval(mins => greatest(v.turnaround_time_minutes,b.teardown_buffer_minutes))) as end_at,
            case when b.status='AFFECTED_BY_UNAVAILABILITY' then 'Venue affected' else 'Confirmed booking' end as reason,
            null::timestamptz as expires_at,
            b.start_at as event_start_at, b.end_at as event_end_at,
            -- Display grouping is not proven provenance: retain the original details.
            coalesce((select jsonb_agg(jsonb_build_object('id',vb.block_id,'start_at',vb.start_at,
                'end_at',vb.end_at,'reason',vb.block_reason) order by vb.block_id)
                from public.venue_blocks vb
                where vb.source_booking_id is null and vb.venue_id=b.venue_id
                    and vb.start_at=b.effective_start_at and vb.end_at=b.effective_end_at
                    and vb.block_issuer=b.reviewed_by
                    and vb.block_reason='Approved Booking: '||e.name||' ('||b.room_layout||')'
                    and 1=(select count(*) from public.venue_bookings other
                        join public.events oe on oe.id=other.event_id
                        where other.venue_id=vb.venue_id and other.effective_start_at=vb.start_at
                            and other.effective_end_at=vb.end_at and other.reviewed_by=vb.block_issuer
                            and vb.block_reason='Approved Booking: '||oe.name||' ('||other.room_layout||')'
                            and other.status in ('APPROVED','AFFECTED_BY_UNAVAILABILITY'))), '[]'::jsonb) as legacy_blocks
        from public.venue_bookings b join public.venues v on v.id=b.venue_id
        left join public.events e on e.id=b.event_id
        where not p_holds_only and b.venue_id=any(p_venue_ids)
            and b.status in ('APPROVED', 'AFFECTED_BY_UNAVAILABILITY')
        union all
        select h.hold_id, h.venue_id, 'tentative_hold',
            h.start_at - make_interval(mins => v.setup_time_minutes),
            h.end_at + make_interval(mins => v.turnaround_time_minutes),
            'Tentative hold', h.expires_at, h.start_at, h.end_at, '[]'::jsonb
        from public.venue_tentative_holds h join public.venues v on v.id=h.venue_id
        where h.venue_id=any(p_venue_ids) and h.released_at is null and h.expires_at>now()
            and (p_exclude_event_id is null or h.event_id<>p_exclude_event_id)
    ) r);
end; $$;

create or replace function venue_private.create_venue_tentative_hold(
    p_venue_id uuid, p_event_id uuid, p_start_at timestamptz, p_end_at timestamptz, p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v public.venues%rowtype;
    e public.events%rowtype;
    h public.venue_tentative_holds%rowtype;
    occupied_start timestamptz;
    occupied_end timestamptz;
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can create holds.' using errcode = '42501';
    end if;
    -- Serialize hold creation on a venue. Existing approval/block workflows
    -- still need the team's shared locking contract to eliminate cross-flow races.
    select * into v from public.venues where id=p_venue_id for update;
    select * into e from public.events where id=p_event_id;
    if v.id is null or e.id is null or e.coordinator_id is null
        or e.status not in ('under_review', 'planning', 'change_requested', 'confirmed')
        or e.end_time<=now() or p_start_at>=p_end_at or p_expires_at<=now()
        or p_expires_at>p_start_at or p_start_at is null or p_end_at is null or p_expires_at is null
        or v.operating_hours->>'open' is null or v.operating_hours->>'close' is null
        or v.setup_time_minutes is null or v.turnaround_time_minutes is null then
        raise exception 'Invalid hold period, event, expiry or venue buffers.' using errcode = '22023';
    end if;
    occupied_start := p_start_at - make_interval(mins => v.setup_time_minutes);
    occupied_end := p_end_at + make_interval(mins => v.turnaround_time_minutes);
    if p_expires_at>occupied_start
        or (occupied_start at time zone 'Asia/Singapore')::date<>(occupied_end at time zone 'Asia/Singapore')::date
        or (occupied_start at time zone 'Asia/Singapore')::time<(v.operating_hours->>'open')::time
        or (occupied_end at time zone 'Asia/Singapore')::time>(v.operating_hours->>'close')::time then
        raise exception 'Expiry must precede setup; occupied time must fit operating hours.' using errcode='22023';
    end if;
    if exists (select 1 from public.venue_blocks b where b.venue_id=p_venue_id
        and b.start_at<occupied_end and occupied_start<b.end_at)
        or exists (select 1 from jsonb_array_elements(venue_private.get_venue_reservations(array[p_venue_id])) r
            where (r->>'start_at')::timestamptz<occupied_end and occupied_start<(r->>'end_at')::timestamptz) then
        raise exception 'Venue period already occupied.' using errcode = '23P01';
    end if;
    insert into public.venue_tentative_holds(venue_id,event_id,start_at,end_at,expires_at,created_by)
        values(p_venue_id,p_event_id,p_start_at,p_end_at,p_expires_at,auth.uid()) returning * into h;
    return to_jsonb(h)||jsonb_build_object('event_name',e.name,'venue_name',v.name,'coordinator_id',e.coordinator_id);
end; $$;

create or replace function venue_private.complete_venue_holds()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.status='APPROVED' then
        update public.venue_tentative_holds set released_at=clock_timestamp(), completed_booking_id=new.booking_id
        where event_id=new.event_id and venue_id=new.venue_id and released_at is null
            and start_at>=new.start_at and end_at<=new.end_at;
    end if;
    return new;
end; $$;
drop trigger if exists complete_venue_holds on public.venue_bookings;
create trigger complete_venue_holds after insert or update of status on public.venue_bookings
    for each row execute function venue_private.complete_venue_holds();

-- Small bounded batches with expiring leases; executable by the system runner only.
create or replace function public.claim_expired_venue_holds()
returns jsonb language sql security invoker set search_path = '' as $$
    with due as (
        select hold_id from public.venue_tentative_holds
        where expires_at<=now() and expiry_notified_at is null
            and (released_at is null or released_at>=expires_at)
            and (expiry_claimed_at is null or expiry_claimed_at<now()-interval '5 minutes')
        order by expires_at limit 100 for update skip locked
    ), claimed as (
        update public.venue_tentative_holds h set expiry_claimed_at=clock_timestamp()
        from due where h.hold_id=due.hold_id returning h.*
    ) select coalesce(jsonb_agg(jsonb_build_object(
        'hold_id',c.hold_id,'expiry_claimed_at',c.expiry_claimed_at,'completed_booking_id',c.completed_booking_id,
        'event_id',c.event_id,'event_name',e.name,'venue_name',v.name,'coordinator_id',e.coordinator_id
    )), '[]'::jsonb) from claimed c join public.events e on e.id=c.event_id join public.venues v on v.id=c.venue_id;
$$;
create or replace function public.acknowledge_venue_hold_expiry(p_hold_id uuid,p_claim timestamptz)
returns void language sql security invoker set search_path = '' as $$
    update public.venue_tentative_holds set expiry_notified_at=now()
    where hold_id=p_hold_id and expiry_claimed_at=p_claim;
$$;
revoke all on function public.claim_expired_venue_holds() from public,anon,authenticated;
revoke all on function public.acknowledge_venue_hold_expiry(uuid,timestamptz) from public,anon,authenticated;
grant select,update on public.venue_tentative_holds to service_role;
grant execute on function public.claim_expired_venue_holds() to service_role;
grant execute on function public.acknowledge_venue_hold_expiry(uuid,timestamptz) to service_role;

-- Scalar JSON guarantees completeness despite the Data API row limit.
create or replace function public.get_venue_operational_blocks(
    p_venue_ids uuid[], p_start_at timestamptz, p_end_at timestamptz
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles p where p.id=auth.uid() and p.role in ('venue_staff','coordinator')
    ) then
        raise exception 'Only venue staff and Coordinators can check venue blocks.' using errcode='42501';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object(
        'block_id',b.block_id,'venue_id',b.venue_id,'start_at',b.start_at,'end_at',b.end_at,
        'block_reason',b.block_reason,'source_booking_id',b.source_booking_id
    ) order by b.start_at,b.block_id),'[]'::jsonb) from public.venue_blocks b
        where b.venue_id=any(p_venue_ids) and b.start_at<p_end_at and p_start_at<b.end_at);
end; $$;
revoke all on function public.get_venue_operational_blocks(uuid[],timestamptz,timestamptz) from public,anon;
grant execute on function public.get_venue_operational_blocks(uuid[],timestamptz,timestamptz) to authenticated;

create or replace function public.get_venue_hold_events()
returns jsonb language sql stable security invoker set search_path = '' as $$
    select venue_private.get_venue_hold_events();
$$;
create or replace function public.get_venue_reservations(
    p_venue_ids uuid[],p_exclude_event_id uuid default null,p_holds_only boolean default false
) returns jsonb language sql stable security invoker set search_path = '' as $$
    select venue_private.get_venue_reservations(p_venue_ids,p_exclude_event_id,p_holds_only);
$$;
create or replace function public.create_venue_tentative_hold(
    p_venue_id uuid,p_event_id uuid,p_start_at timestamptz,p_end_at timestamptz,p_expires_at timestamptz
) returns jsonb language sql security invoker set search_path = '' as $$
    select venue_private.create_venue_tentative_hold(p_venue_id,p_event_id,p_start_at,p_end_at,p_expires_at);
$$;
revoke all on function venue_private.get_venue_hold_events() from public,anon;
revoke all on function venue_private.get_venue_reservations(uuid[],uuid,boolean) from public,anon;
revoke all on function venue_private.create_venue_tentative_hold(uuid,uuid,timestamptz,timestamptz,timestamptz) from public,anon;
revoke all on function venue_private.complete_venue_holds() from public,anon,authenticated;
revoke all on function public.get_venue_hold_events() from public,anon;
revoke all on function public.get_venue_reservations(uuid[],uuid,boolean) from public,anon;
revoke all on function public.create_venue_tentative_hold(uuid,uuid,timestamptz,timestamptz,timestamptz) from public,anon;
grant execute on function venue_private.get_venue_hold_events() to authenticated;
grant execute on function venue_private.get_venue_reservations(uuid[],uuid,boolean) to authenticated;
grant execute on function venue_private.create_venue_tentative_hold(uuid,uuid,timestamptz,timestamptz,timestamptz) to authenticated;
grant execute on function public.get_venue_hold_events() to authenticated;
grant execute on function public.get_venue_reservations(uuid[],uuid,boolean) to authenticated;
grant execute on function public.create_venue_tentative_hold(uuid,uuid,timestamptz,timestamptz,timestamptz) to authenticated;
commit;
