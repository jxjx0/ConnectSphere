-- Allow cancellation requests during all active event workflow states except
-- initial review. Apply this after event_cancellation_requests.sql if that
-- migration was already applied with the original status list.

alter table public.events drop constraint if exists events_status_valid;
alter table public.events add constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check', 'cancellation_requested', 'cancelled'
));

alter table public.event_cancellation_requests
    add column if not exists previous_event_status text;

update public.event_cancellation_requests r
set previous_event_status = e.status
from public.events e
where r.event_id = e.id and r.previous_event_status is null;

alter table public.event_cancellation_requests
    drop constraint if exists event_cancellation_requests_previous_event_status_check;
alter table public.event_cancellation_requests
    add constraint event_cancellation_requests_previous_event_status_check
    check (previous_event_status in (
        'planning', 'awaiting_safety_check', 'confirmed',
        'awaiting_clarification', 'change_requested'
    ));
alter table public.event_cancellation_requests
    alter column previous_event_status set not null;

create or replace function public.submit_event_cancellation_request(
    p_event_id uuid,
    p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    cancellation_request_id uuid;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can request event cancellation';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if exists (
        select 1 from public.event_cancellation_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending cancellation request already exists';
    end if;

    if current_event.status not in (
        'planning', 'awaiting_safety_check', 'confirmed',
        'awaiting_clarification', 'change_requested'
    ) then
        raise exception 'Event cannot be cancelled in its current status';
    end if;

    insert into public.event_cancellation_requests (
        event_id, organiser_id, reason, previous_event_status
    ) values (
        p_event_id, auth.uid(), btrim(p_reason), current_event.status
    ) returning id into cancellation_request_id;

    update public.events
    set status = 'cancellation_requested', updated_at = now()
    where id = p_event_id;

    return cancellation_request_id;
end;
$$;

revoke all on function public.submit_event_cancellation_request(uuid, text)
    from public;
grant execute on function public.submit_event_cancellation_request(uuid, text)
    to authenticated;
