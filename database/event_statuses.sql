-- Switch public.events to the team's agreed status set.
-- Run this only if events.sql, event_drafts.sql, event_change_requests.sql
-- and event_change_request_reason.sql have already been applied.
--
-- Agreed statuses:
--   draft, under_review, rejected, planning, confirmed, completed,
--   change_requested, awaiting_clarification
--
-- Design notes:
--   * 'submitted' is gone: a request goes straight to 'under_review' when
--     the Organiser submits it (Coordinator assignment is automatic).
--   * 'approved' is gone: a Coordinator approving a request moves it to
--     'planning'. 'approved' had been added to the live database by hand
--     and the backend could not read those rows.
--   * Change requests are allowed from under_review, planning and
--     confirmed -- every stage from submission until the event happens.
--   * The Coordinator policies at the bottom were created directly in
--     Supabase for the Coordinator review feature. They are re-created
--     here only so they keep working with the new statuses.

-- 1. Existing rows move to their new status. Both new values are already
--    allowed by the old constraint, so this runs before it is replaced.
update public.events set status = 'under_review' where status = 'submitted';
update public.events set status = 'planning' where status = 'approved';

-- 2. The new status set, and the status a newly created row starts with.
alter table public.events drop constraint if exists events_status_valid;
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

alter table public.events alter column status set default 'under_review';

-- 3. Change requests record the stage the event was at. The old check is
--    dropped first because it does not allow 'under_review'.
alter table public.event_change_requests
    drop constraint if exists event_change_requests_event_status_before_request_check;

update public.event_change_requests
set event_status_before_request = 'under_review'
where event_status_before_request = 'submitted';

alter table public.event_change_requests
    add constraint event_change_requests_event_status_before_request_check
    check (event_status_before_request in (
        'under_review', 'planning', 'confirmed'
    ));

-- 4. Submitting a draft now moves it to 'under_review'.
drop policy if exists "Organisers can edit their own drafts" on public.events;
create policy "Organisers can edit their own drafts"
    on public.events
    for update
    to authenticated
    using (organiser_id = (select auth.uid()) and status = 'draft')
    with check (
        organiser_id = (select auth.uid())
        and status in ('draft', 'under_review')
    );

-- 5. Coordinators review requests that are 'under_review', and approve one
--    by moving it to 'planning' (or reject it). They can view all assigned
--    submitted requests as those requests move through later statuses.
drop policy if exists "Coordinators can decide their assigned submitted events"
    on public.events;
drop policy if exists "Coordinators can decide their assigned events under review"
    on public.events;
create policy "Coordinators can decide their assigned events under review"
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

drop policy if exists "Coordinators can view their assigned submitted events"
    on public.events;
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

-- 6. The change request function, with the new allowed statuses. Otherwise
--    identical to the version in event_change_request_reason.sql.
create or replace function public.submit_event_change_request(
    p_event_id uuid,
    p_organiser_id uuid,
    p_changes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    change_request_id uuid;
    new_category_other text;
    new_location text;
    new_layout text;
    new_accessibility text;
    new_equipment text;
begin
    if auth.uid() is null
        or auth.uid() <> p_organiser_id
        or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can submit a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = p_organiser_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status not in ('under_review', 'planning', 'confirmed') then
        raise exception 'Event cannot be changed in its current status';
    end if;

    if exists (
        select 1 from public.event_change_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending change request already exists';
    end if;

    new_category_other := nullif(btrim(p_changes->>'category_other'), '');
    new_location := case
        when lower(btrim(p_changes->>'location_preference')) = 'nil' then null
        else nullif(btrim(p_changes->>'location_preference'), '')
    end;
    new_layout := case
        when lower(btrim(p_changes->>'layout_preference')) = 'nil' then null
        else nullif(btrim(p_changes->>'layout_preference'), '')
    end;
    new_accessibility := case
        when lower(btrim(p_changes->>'accessibility_requirements')) = 'nil' then null
        else nullif(btrim(p_changes->>'accessibility_requirements'), '')
    end;
    new_equipment := case
        when lower(btrim(p_changes->>'equipment_requirements')) = 'nil' then null
        else nullif(btrim(p_changes->>'equipment_requirements'), '')
    end;

    if current_event.name is not distinct from p_changes->>'name'
        and current_event.description is not distinct from p_changes->>'description'
        and current_event.purpose is not distinct from p_changes->>'purpose'
        and current_event.category::text is not distinct from p_changes->>'category'
        and current_event.category_other is not distinct from new_category_other
        and date_trunc('minute', current_event.start_time) is not distinct from date_trunc('minute', (p_changes->>'start_time')::timestamptz)
        and date_trunc('minute', current_event.end_time) is not distinct from date_trunc('minute', (p_changes->>'end_time')::timestamptz)
        and current_event.expected_attendance is not distinct from (p_changes->>'expected_attendance')::integer
        and (case when lower(btrim(current_event.location_preference)) = 'nil' then null else btrim(current_event.location_preference) end) is not distinct from new_location
        and (case when lower(btrim(current_event.layout_preference)) = 'nil' then null else btrim(current_event.layout_preference) end) is not distinct from new_layout
        and (case when lower(btrim(current_event.accessibility_requirements)) = 'nil' then null else btrim(current_event.accessibility_requirements) end) is not distinct from new_accessibility
        and (case when lower(btrim(current_event.equipment_requirements)) = 'nil' then null else btrim(current_event.equipment_requirements) end) is not distinct from new_equipment then
        raise exception 'No event details were changed';
    end if;

    insert into public.event_change_requests (
        event_id, organiser_id, event_status_before_request,
        name, description, reason_for_change, purpose, category,
        category_other, start_time, end_time, expected_attendance,
        location_preference, layout_preference, accessibility_requirements,
        equipment_requirements
    ) values (
        p_event_id, p_organiser_id, current_event.status,
        p_changes->>'name', p_changes->>'description',
        p_changes->>'reason_for_change', p_changes->>'purpose',
        p_changes->>'category', new_category_other,
        (p_changes->>'start_time')::timestamptz,
        (p_changes->>'end_time')::timestamptz,
        (p_changes->>'expected_attendance')::integer,
        new_location, new_layout, new_accessibility, new_equipment
    ) returning id into change_request_id;

    update public.events
    set status = 'change_requested'
    where id = p_event_id;

    return change_request_id;
end;
$$;

revoke all on function public.submit_event_change_request(uuid, uuid, jsonb)
    from public;
grant execute on function public.submit_event_change_request(uuid, uuid, jsonb)
    to authenticated;
