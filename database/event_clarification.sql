-- Allow an assigned Coordinator to ask the Organiser for missing details.
-- Apply after event_review.sql (or event_statuses.sql).

alter table public.events add column if not exists clarification_notes text;

alter table public.events drop constraint if exists events_status_valid;
alter table public.events add constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check', 'cancellation_requested', 'cancelled'
));

drop policy if exists "Coordinators can decide their assigned reviewable events"
    on public.events;
create policy "Coordinators can decide their assigned reviewable events"
    on public.events
    for update
    to authenticated
    using (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status in ('under_review', 'planning', 'change_requested')
    )
    with check (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status in ('planning', 'rejected', 'awaiting_clarification')
);

drop policy if exists "Coordinators can view their assigned events under review"
    on public.events;
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
