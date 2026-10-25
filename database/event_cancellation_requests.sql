-- Persist an Organiser's request and preserve the event's status for the
-- Coordinator's later approval or rejection workflow.

alter table public.events drop constraint if exists events_status_valid;
alter table public.events add constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check', 'cancellation_requested', 'cancelled'
));

create table public.event_cancellation_requests (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    organiser_id uuid not null references public.profiles(id),
    reason text not null,
    previous_event_status text not null
        check (previous_event_status in (
            'planning', 'awaiting_safety_check', 'confirmed',
            'awaiting_clarification', 'change_requested'
        )),
    status text not null default 'pending',
    created_at timestamptz not null default now(),

    constraint event_cancellation_requests_reason_not_blank
        check (length(btrim(reason)) > 0),
    constraint event_cancellation_requests_status_valid
        check (status in ('pending', 'approved', 'rejected'))
);

create index event_cancellation_requests_organiser_idx
    on public.event_cancellation_requests (organiser_id, created_at desc);

create unique index event_cancellation_requests_one_pending_per_event
    on public.event_cancellation_requests (event_id)
    where status = 'pending';

alter table public.event_cancellation_requests enable row level security;
grant select on public.event_cancellation_requests to authenticated;

create policy "Organisers can view their own event cancellation requests"
    on public.event_cancellation_requests
    for select
    to authenticated
    using (organiser_id = (select auth.uid()));

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
