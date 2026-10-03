-- Upgrade an existing ConnectSphere database for coordinator event review.
-- Fresh installs also receive these definitions from events.sql.

create index if not exists events_coordinator_status_start_idx
    on public.events (coordinator_id, status, start_time);

grant update on public.events to authenticated;

alter table public.events
    drop constraint if exists events_status_valid;

alter table public.events
    add constraint events_status_valid
        check (status in (
            'draft',
            'under_review',
            'rejected',
            'planning',
            'confirmed',
            'completed',
            'change_requested',
            'awaiting_clarification'
        ));

create or replace function public.is_coordinator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'coordinator'
    );
$$;

revoke all on function public.is_coordinator() from public;
grant execute on function public.is_coordinator() to authenticated;

drop policy if exists "Coordinators can view their assigned submitted events"
    on public.events;
drop policy if exists "Coordinators can view their assigned reviewable events"
    on public.events;
drop policy if exists "Coordinators can view their assigned events under review"
    on public.events;
drop policy if exists "Coordinators can view assigned events"
    on public.events;
drop policy if exists "Coordinators can view their assigned events"
    on public.events;
-- Every assigned event except drafts, so decided events stay visible.
-- Deciding also needs this: the update returns the row after it has
-- moved to planning or rejected.
create policy "Coordinators can view their assigned events"
    on public.events
    for select
    to authenticated
    using (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status <> 'draft'
    );

drop policy if exists "Coordinators can decide their assigned submitted events"
    on public.events;
drop policy if exists "Coordinators can decide their assigned reviewable events"
    on public.events;
create policy "Coordinators can decide their assigned reviewable events"
    on public.events
    for update
    to authenticated
    using (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status = 'under_review'
    )
    with check (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status in ('planning', 'rejected')
    );
