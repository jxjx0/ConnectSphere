-- Coordinator review of Organiser-proposed event changes.
-- Apply to the existing schema after events, event_change_requests and
-- public.is_coordinator() are present. Safe to re-run.
--
-- The current schema already has the awaiting_clarification event status
-- and the event_change_requests.rejection_reason column/check constraint.
-- This migration only adds the coordinator access policy and review RPCs.

grant select on public.event_change_requests to authenticated;

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
create policy "Coordinators can view their assigned events"
    on public.events
    for select
    to authenticated
    using (
        public.is_coordinator()
        and coordinator_id = (select auth.uid())
        and status <> 'draft'
    );

drop policy if exists "Coordinators can view assigned event change requests"
    on public.event_change_requests;
create policy "Coordinators can view assigned event change requests"
    on public.event_change_requests
    for select
    to authenticated
    using (
        public.is_coordinator()
        and exists (
            select 1
            from public.events
            where public.events.id = event_change_requests.event_id
              and public.events.coordinator_id = (select auth.uid())
        )
    );

drop function if exists public.approve_event_change_request(uuid);
create function public.approve_event_change_request(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    select *
    into current_request
    from public.event_change_requests
    where event_id = p_event_id
      and status = 'pending'
    for update;

    if not found then
        raise exception 'Change request is no longer pending';
    end if;

    select *
    into current_event
    from public.events
    where id = p_event_id
      and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    if current_event.status <> 'change_requested' then
        raise exception 'Event is not awaiting change request review';
    end if;

    update public.events
    set name = current_request.name,
        description = current_request.description,
        purpose = current_request.purpose,
        category = current_request.category,
        category_other = current_request.category_other,
        start_time = current_request.start_time,
        end_time = current_request.end_time,
        expected_attendance = current_request.expected_attendance,
        location_preference = current_request.location_preference,
        layout_preference = current_request.layout_preference,
        accessibility_requirements = current_request.accessibility_requirements,
        equipment_requirements = current_request.equipment_requirements,
        status = current_request.event_status_before_request,
        updated_at = now()
    where id = p_event_id
    returning * into current_event;

    update public.event_change_requests
    set status = 'approved',
        reviewed_at = now(),
        rejection_reason = null
    where id = current_request.id
    returning * into current_request;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request)
    );
end;
$$;

drop function if exists public.reject_event_change_request(uuid, text);
create function public.reject_event_change_request(
    p_event_id uuid,
    p_rejection_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    if p_rejection_reason is null or length(btrim(p_rejection_reason)) = 0 then
        raise exception 'A reason is required to reject a change request';
    end if;

    select *
    into current_request
    from public.event_change_requests
    where event_id = p_event_id
      and status = 'pending'
    for update;

    if not found then
        raise exception 'Change request is no longer pending';
    end if;

    select *
    into current_event
    from public.events
    where id = p_event_id
      and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    if current_event.status <> 'change_requested' then
        raise exception 'Event is not awaiting change request review';
    end if;

    update public.events
    set status = current_request.event_status_before_request,
        updated_at = now()
    where id = p_event_id
    returning * into current_event;

    update public.event_change_requests
    set status = 'rejected',
        rejection_reason = btrim(p_rejection_reason),
        reviewed_at = now()
    where id = current_request.id
    returning * into current_request;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request)
    );
end;
$$;

revoke all on function public.approve_event_change_request(uuid) from public;
grant execute on function public.approve_event_change_request(uuid)
    to authenticated;

revoke all on function public.reject_event_change_request(uuid, text) from public;
grant execute on function public.reject_event_change_request(uuid, text)
    to authenticated;
