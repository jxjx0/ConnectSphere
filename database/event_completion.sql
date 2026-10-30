-- T7-266: complete previously confirmed events and expire pending requests.
-- Apply after event_request_expiry.sql and the event/request/session scripts.
-- This script is safe to reapply and does not run completion or install a job.

alter table public.events
    add column if not exists completed_at timestamptz;

-- Session workflows synchronise events.end_time with the final session end.
-- Lock the event and its pending requests before rechecking eligibility.
-- Existing reviews lock requests first; NOWAIT avoids a lock-order deadlock.
-- Busy events are retried on the next minute, without delaying other events.
create or replace function public.complete_ended_events()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    candidate_id uuid;
    current_event record;
    completion_time timestamptz := now();
    completed_count integer := 0;
begin
    for candidate_id in
        select id from public.events
        where status in ('confirmed', 'change_requested', 'cancellation_requested')
          and end_time < completion_time
        order by id
    loop
        -- A subtransaction releases this event's locks if a request is busy.
        begin
            select status, end_time into current_event from public.events
            where id = candidate_id for update skip locked;
            if not found then
                continue;
            end if;

            perform 1 from public.event_change_requests
            where event_id = candidate_id and status = 'pending'
            order by id for update nowait;
            perform 1 from public.event_cancellation_requests
            where event_id = candidate_id and status = 'pending'
            order by id for update nowait;

            if current_event.end_time < completion_time and (
                current_event.status = 'confirmed'
                or (current_event.status = 'change_requested' and exists (
                    select 1 from public.event_change_requests
                    where event_id = candidate_id and status = 'pending'
                      and event_status_before_request = 'confirmed'
                ))
                or (current_event.status = 'cancellation_requested' and exists (
                    select 1 from public.event_cancellation_requests r
                    where r.event_id = candidate_id and r.status = 'pending'
                      and (r.previous_event_status = 'confirmed'
                        or (r.previous_event_status = 'change_requested' and exists (
                            select 1 from public.event_change_requests c
                            where c.event_id = candidate_id and c.status = 'pending'
                              and c.event_status_before_request = 'confirmed'
                        )))
                ))
            ) then
                update public.events
                set status = 'completed',
                    completed_at = coalesce(completed_at, completion_time),
                    updated_at = completion_time
                where id = candidate_id;

                update public.event_change_requests set status = 'expired'
                where event_id = candidate_id and status = 'pending';
                update public.event_cancellation_requests set status = 'expired'
                where event_id = candidate_id and status = 'pending';
                completed_count := completed_count + 1;
            end if;
        exception when lock_not_available then
            -- No event/request writes have happened before lock acquisition.
            null;
        end;
    end loop;
    -- Scalar result cannot be truncated by the Data API row limit.
    return completed_count;
end;
$$;

-- Only a trusted system runner may invoke this operation. Do not broaden
-- user RLS policies or expose a completion action to signed-in users.
revoke all on function public.complete_ended_events() from public, anon, authenticated;
grant select (id, status, end_time, completed_at), update (status, completed_at, updated_at)
    on public.events to service_role;
grant select (id, event_id, status, event_status_before_request), update (status)
    on public.event_change_requests to service_role;
grant select (id, event_id, status, previous_event_status), update (status)
    on public.event_cancellation_requests to service_role;
grant execute on function public.complete_ended_events() to service_role;

-- Keep this invariant at the request tables as well as in each submission RPC.
-- In particular, the session-change RPC is owned by a separate migration.
-- Locking the parent serializes a new request with a simultaneous completion.
create or replace function public.reject_completed_event_request()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    event_status text;
begin
    if new.status <> 'pending' then
        return new;
    end if;

    select status into event_status from public.events
    where id = new.event_id for update;
    if not found then
        raise exception 'Event request was not found';
    end if;
    if event_status = 'completed' then
        if tg_table_name = 'event_change_requests' then
            raise exception 'Event cannot be changed in its current status';
        end if;
        raise exception 'Event cannot be cancelled in its current status';
    end if;
    return new;
end;
$$;

revoke all on function public.reject_completed_event_request() from public, anon, authenticated;

drop trigger if exists event_change_requests_reject_completed on public.event_change_requests;
create trigger event_change_requests_reject_completed
before insert on public.event_change_requests
for each row execute function public.reject_completed_event_request();

drop trigger if exists event_cancellation_requests_reject_completed on public.event_cancellation_requests;
create trigger event_cancellation_requests_reject_completed
before insert on public.event_cancellation_requests
for each row execute function public.reject_completed_event_request();
