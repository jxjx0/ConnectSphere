-- Clarification request and response history.
-- Apply after events.sql, event_drafts.sql, event_review.sql and
-- event_statuses.sql.

alter table public.events drop constraint if exists events_status_valid;
alter table public.events add constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check', 'cancellation_requested', 'cancelled'
));

create table if not exists public.event_clarifications (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    organiser_id uuid not null references public.profiles(id),
    coordinator_id uuid not null references public.profiles(id),
    coordinator_notes text not null
        check (length(btrim(coordinator_notes)) between 1 and 5000),
    organiser_response text
        check (organiser_response is null or length(btrim(organiser_response)) between 1 and 5000),
    requested_at timestamptz not null default now(),
    responded_at timestamptz
);

-- Preserve the workflow status that was active before clarification.
-- Existing clarification rows cannot always be traced to their prior status;
-- NULL rows retain the historical Under Review fallback on response.
alter table public.event_clarifications
    add column if not exists previous_status text
        check (previous_status in ('under_review', 'planning', 'change_requested'));

create index if not exists event_clarifications_event_requested_idx
    on public.event_clarifications (event_id, requested_at);

-- Earlier versions stored the current request on events.clarification_notes.
-- Preserve any outstanding request when moving it into the history table.
do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'events'
          and column_name = 'clarification_notes'
    ) then
        execute $backfill$
            insert into public.event_clarifications (
                event_id, organiser_id, coordinator_id,
                coordinator_notes, requested_at
            )
            select e.id, e.organiser_id, e.coordinator_id,
                   btrim(e.clarification_notes), coalesce(e.updated_at, now())
            from public.events e
            where e.status = 'awaiting_clarification'
              and e.coordinator_id is not null
              and nullif(btrim(e.clarification_notes), '') is not null
              and not exists (
                  select 1 from public.event_clarifications c
                  where c.event_id = e.id
              )
        $backfill$;
    end if;
end;
$$;

alter table public.event_clarifications enable row level security;
grant select on public.event_clarifications to authenticated;

drop policy if exists "Event participants can view clarification history"
    on public.event_clarifications;
create policy "Event participants can view clarification history"
    on public.event_clarifications
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.events e
            where e.id = event_clarifications.event_id
              and (
                  (public.is_organiser() and e.organiser_id = (select auth.uid()))
                  or (public.is_coordinator() and e.coordinator_id = (select auth.uid()))
              )
        )
    );

drop policy if exists "Coordinators can view their assigned events"
    on public.events;
create policy "Coordinators can view their assigned events"
    on public.events
    for select
    to authenticated
    using (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status <> 'draft'
    );

create or replace function public.request_event_clarification(
    p_event_id uuid,
    p_coordinator_id uuid,
    p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_coordinator_id
        or not public.is_coordinator() then
        raise exception 'Only the assigned Coordinator can request clarification';
    end if;

    if p_notes is null or length(btrim(p_notes)) not between 1 and 5000 then
        raise exception 'Clarification notes must contain between 1 and 5000 characters';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = p_coordinator_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;
    if current_event.status not in ('under_review', 'planning', 'change_requested') then
        raise exception 'Event cannot be clarified in its current status';
    end if;

    insert into public.event_clarifications (
        event_id, organiser_id, coordinator_id, coordinator_notes,
        previous_status
    ) values (
        p_event_id, current_event.organiser_id, p_coordinator_id, btrim(p_notes),
        current_event.status
    ) returning id into clarification_id;

    update public.events
    set status = 'awaiting_clarification', updated_at = now()
    where id = p_event_id;

    return clarification_id;
end;
$$;

revoke all on function public.request_event_clarification(uuid, uuid, text) from public;
grant execute on function public.request_event_clarification(uuid, uuid, text) to authenticated;

create or replace function public.respond_to_event_clarification(
    p_event_id uuid,
    p_organiser_id uuid,
    p_response text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    current_clarification public.event_clarifications%rowtype;
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_organiser_id
        or not public.is_organiser() then
        raise exception 'Only the signed-in Organiser can respond to clarification';
    end if;

    if p_response is null or length(btrim(p_response)) not between 1 and 5000 then
        raise exception 'Your response must contain between 1 and 5000 characters';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = p_organiser_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;
    if current_event.status <> 'awaiting_clarification' then
        raise exception 'Event is not awaiting clarification';
    end if;

    select * into current_clarification
    from public.event_clarifications
    where event_id = p_event_id and responded_at is null
    order by requested_at desc
    limit 1
    for update;

    if current_clarification.id is null then
        raise exception 'No clarification is awaiting a response';
    end if;
    clarification_id := current_clarification.id;

    update public.event_clarifications
    set organiser_response = btrim(p_response), responded_at = now()
    where id = clarification_id;

    update public.events
    set status = coalesce(current_clarification.previous_status, 'under_review'),
        updated_at = now()
    where id = p_event_id;

    return clarification_id;
end;
$$;

revoke all on function public.respond_to_event_clarification(uuid, uuid, text) from public;
grant execute on function public.respond_to_event_clarification(uuid, uuid, text) to authenticated;
