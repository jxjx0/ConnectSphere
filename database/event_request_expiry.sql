-- T7-266: additive request status upgrade. Apply BEFORE event_completion.sql.
-- Generated with `supabase migration new event_request_expiry`, kept in the
-- repository's database/ script convention. No rows or workflows are changed.
-- A short lock timeout lets an operator retry instead of blocking active work.
begin;
set local lock_timeout = '5s';

alter table public.event_change_requests
    drop constraint if exists event_change_requests_status_valid;
alter table public.event_change_requests
    add constraint event_change_requests_status_valid
    check (status in ('pending', 'approved', 'rejected', 'expired')) not valid;

alter table public.event_cancellation_requests
    drop constraint if exists event_cancellation_requests_status_valid;
alter table public.event_cancellation_requests
    add constraint event_cancellation_requests_status_valid
    check (status in ('pending', 'approved', 'rejected', 'expired')) not valid;
commit;

-- Validate separately so the table scan does not retain the stronger DDL lock.
-- NOT VALID still enforces the new rule for every insert/update immediately.
alter table public.event_change_requests
    validate constraint event_change_requests_status_valid;
alter table public.event_cancellation_requests
    validate constraint event_cancellation_requests_status_valid;
