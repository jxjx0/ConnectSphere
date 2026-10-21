-- Apply after events and profiles. Already applied to the shared Supabase
-- project on 21 Oct 2026; kept here for review and rebuilding a database.
-- T7-272: Add event sessions table to database
-- Backward compatible: adds a table, a trigger and policies; changes no
-- existing column or rule, so code on main keeps working.

-- 1. The table. Columns are nullable because a draft may be incomplete;
--    the backend requires them on submit.
create table public.event_sessions (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    name text,
    start_time timestamptz,
    end_time timestamptz,
    expected_attendance integer,
    location_preference text,
    layout_preference text,
    equipment_requirements text,
    created_at timestamptz not null default now(),
    constraint event_sessions_name_not_blank
        check (name is null or length(btrim(name)) > 0),
    constraint event_sessions_end_after_start
        check (start_time is null or end_time is null or end_time > start_time),
    constraint event_sessions_attendance_positive
        check (expected_attendance is null or expected_attendance > 0)
);

create index event_sessions_event_id_idx on public.event_sessions (event_id);

-- 2. Keep the event's overall span and largest attendance in step with its
--    sessions: earliest start, latest end, largest attendance. In a
--    half-filled draft the earliest start could come after the latest end;
--    the span is then left empty rather than breaking events_end_after_start.
--    SECURITY DEFINER because it only recalculates derived columns and must
--    work whoever changed the sessions.
create or replace function public.sync_event_from_sessions()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    target_event_id uuid := coalesce(new.event_id, old.event_id);
    first_start timestamptz;
    last_end timestamptz;
    largest_attendance integer;
begin
    select min(start_time), max(end_time), max(expected_attendance)
    into first_start, last_end, largest_attendance
    from public.event_sessions
    where event_id = target_event_id;

    if first_start >= last_end then
        first_start := null;
        last_end := null;
    end if;

    update public.events
    set start_time = first_start,
        end_time = last_end,
        expected_attendance = largest_attendance
    where id = target_event_id;
    return null;
end;
$$;

create trigger event_sessions_sync_event
after insert or update or delete on public.event_sessions
for each row execute function public.sync_event_from_sessions();

-- 3. Access rules.
alter table public.event_sessions enable row level security;
revoke all on public.event_sessions from anon;

-- Anyone who can see the event can see its sessions. The subquery on
-- events is itself filtered by the events policies, so this follows every
-- existing read rule (Organiser, Coordinator, Tech Support).
create policy "Users can view sessions of events they can view"
on public.event_sessions for select to authenticated
using (exists (select 1 from public.events e where e.id = event_id));

-- Organisers write sessions only while the event is their own draft,
-- matching how drafts work today. Submitting is an update of the draft.
create policy "Organisers can add sessions to their own drafts"
on public.event_sessions for insert to authenticated
with check (exists (
    select 1 from public.events e
    where e.id = event_id
      and e.organiser_id = (select auth.uid())
      and e.status = 'draft'));

create policy "Organisers can edit sessions of their own drafts"
on public.event_sessions for update to authenticated
using (exists (
    select 1 from public.events e
    where e.id = event_id
      and e.organiser_id = (select auth.uid())
      and e.status = 'draft'))
with check (exists (
    select 1 from public.events e
    where e.id = event_id
      and e.organiser_id = (select auth.uid())
      and e.status = 'draft'));

create policy "Organisers can remove sessions from their own drafts"
on public.event_sessions for delete to authenticated
using (exists (
    select 1 from public.events e
    where e.id = event_id
      and e.organiser_id = (select auth.uid())
      and e.status = 'draft'));

-- 4. Existing events become one session each, copying their current
--    details. The trigger recalculates the same span and attendance.
insert into public.event_sessions (
    event_id, name, start_time, end_time, expected_attendance,
    location_preference, layout_preference, equipment_requirements)
select id, 'Main session', start_time, end_time, expected_attendance,
       location_preference, layout_preference, equipment_requirements
from public.events;

-- Follow-up (applied separately): the trigger function is not an API call.
revoke execute on function public.sync_event_from_sessions() from public, anon, authenticated;

-- T7-273: replace all sessions of one of the caller's drafts, in one
-- transaction. SECURITY INVOKER: the event_sessions policies still apply,
-- so this only works on the signed-in Organiser's own draft.
create or replace function public.replace_draft_sessions(p_event_id uuid, p_sessions jsonb)
returns setof public.event_sessions
language plpgsql
security invoker
set search_path to ''
as $$
begin
    delete from public.event_sessions where event_id = p_event_id;
    return query
    insert into public.event_sessions (
        event_id, name, start_time, end_time, expected_attendance,
        location_preference, layout_preference, equipment_requirements)
    select p_event_id, s.name, s.start_time, s.end_time, s.expected_attendance,
           s.location_preference, s.layout_preference, s.equipment_requirements
    from jsonb_to_recordset(p_sessions) as s(
        name text, start_time timestamptz, end_time timestamptz,
        expected_attendance integer, location_preference text,
        layout_preference text, equipment_requirements text)
    returning *;
end;
$$;

revoke execute on function public.replace_draft_sessions(uuid, jsonb) from public, anon;
grant execute on function public.replace_draft_sessions(uuid, jsonb) to authenticated;

-- Undo (only if this migration must be reversed):
-- drop function public.replace_draft_sessions(uuid, jsonb);
-- drop table public.event_sessions;
-- drop function public.sync_event_from_sessions();
