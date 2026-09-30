-- Assign an Event Coordinator automatically when a request is submitted.
-- Run this after events.sql and event_statuses.sql.
--
-- Replaces the trigger that was created directly in Supabase. That version
-- had two problems:
--   * It ran as the Organiser submitting the request. Organisers can only
--     read their own row in profiles, so it never found a coordinator and
--     coordinator_id stayed null.
--   * It also ran for drafts, so a coordinator would be assigned before
--     the request was actually submitted.
--
-- How it works now:
--   * It runs only when a row is (or becomes) 'under_review' with no
--     coordinator -- a new submission, or a draft being submitted.
--   * security definer: it runs with the function owner's rights, so it can
--     read every coordinator profile and count their events. It only ever
--     sets coordinator_id on the row being saved.
--   * The coordinator with the fewest assigned events gets the request.
--     Ties go to the lowest id, so the choice is predictable.
--   * If there are no coordinators, coordinator_id stays null.

create or replace function public.auto_assign_coordinator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    select public.profiles.id into new.coordinator_id
    from public.profiles
    where public.profiles.role = 'coordinator'
    order by (
        select count(*)
        from public.events
        where public.events.coordinator_id = public.profiles.id
    ), public.profiles.id
    limit 1;

    return new;
end;
$$;

-- Only the trigger should call this function.
revoke all on function public.auto_assign_coordinator() from public;

drop trigger if exists trigger_auto_assign_coordinator on public.events;
create trigger trigger_auto_assign_coordinator
    before insert or update on public.events
    for each row
    when (new.status = 'under_review' and new.coordinator_id is null)
    execute function public.auto_assign_coordinator();

-- One-off: give a coordinator to requests already submitted without one.
-- Setting status to itself fires the trigger above for each of them.
update public.events
set status = status
where status = 'under_review' and coordinator_id is null;
