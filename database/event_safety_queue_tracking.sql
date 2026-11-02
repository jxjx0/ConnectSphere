-- Remembers that an event was in the Safety Officer's queue, so one cancelled
-- or rejected while waiting can be listed as no longer needing a check rather
-- than simply disappearing.
--
-- safety_check_requested_at is set when an event enters the queue. It clears
-- when the event moves on normally, to Planning or Confirmed, and stays when
-- the event ends, which is what marks it as having expired in the queue.
--
-- Events that ended in the queue before this migration cannot be identified, so
-- they are not listed.
--
-- Requires: events.sql. Apply this before deploying the code that uses it.

begin;

alter table public.events
    add column safety_check_requested_at timestamptz;

update public.events
set safety_check_requested_at = updated_at
where status = 'awaiting_safety_check';

create function public.track_safety_check_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.status = 'awaiting_safety_check' then
        new.safety_check_requested_at := now();
    elsif new.status in ('planning', 'confirmed') then
        new.safety_check_requested_at := null;
    end if;
    return new;
end;
$$;

revoke all on function public.track_safety_check_request() from public, anon, authenticated;

create trigger events_track_safety_check_request
before update of status on public.events
for each row
when (old.status is distinct from new.status)
execute function public.track_safety_check_request();

commit;
