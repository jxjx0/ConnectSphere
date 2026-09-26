-- Draft event requests (T7-37).
-- Run this only if events.sql has already been applied. It is safe to run
-- more than once.
--
-- Design notes:
--   * A draft is still a row in public.events with status = 'draft' -- no
--     separate table. Submitting a draft just changes its status.
--   * Drafts may be incomplete, so the form fields lose NOT NULL. name
--     stays required so every draft has something to be listed by.
--   * The existing checks (not blank, end after start, attendance > 0,
--     category rules) still apply whenever a value is present: a check on a
--     NULL value passes, so they do not need rewriting.
--   * Once an event is no longer a draft, every required field must be
--     filled in (events_complete_unless_draft).
--   * Organisers may edit and delete only their own drafts. A submitted
--     event changes only through a change request.

-- 1. Drafts may be half-filled.
alter table public.events
    alter column description         drop not null,
    alter column purpose             drop not null,
    alter column category            drop not null,
    alter column start_time          drop not null,
    alter column end_time            drop not null,
    alter column expected_attendance drop not null;

-- 2. Anything past draft must be complete.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'events_complete_unless_draft'
          and conrelid = 'public.events'::regclass
    ) then
        alter table public.events
            add constraint events_complete_unless_draft
            check (
                status = 'draft'
                or (
                    description is not null
                    and purpose is not null
                    and category is not null
                    and start_time is not null
                    and end_time is not null
                    and expected_attendance is not null
                )
            );
    end if;
end;
$$;

-- 3. When a draft was last edited, for the Drafts tab. The backend sets
--    it on every save.
alter table public.events
    add column if not exists updated_at timestamptz not null default now();

-- 4. Organisers may change only the form fields -- never organiser_id or
--    coordinator_id -- and may delete. The policies below narrow both to
--    their own drafts.
--    Supabase grants table-wide UPDATE to authenticated by default, which
--    covers every column and would make the column list below pointless,
--    so it is revoked first. submit_event_change_request is security
--    definer and does not depend on this grant.
revoke update on public.events from authenticated;
grant update (
    name, description, purpose, category, category_other,
    start_time, end_time, expected_attendance,
    location_preference, layout_preference,
    accessibility_requirements, equipment_requirements,
    status, updated_at
) on public.events to authenticated;

grant delete on public.events to authenticated;

-- 5. Only their own drafts. After an edit the row must still be a draft,
--    or be 'submitted' (that is the submit action) -- an Organiser cannot
--    move their own event to any later status.
drop policy if exists "Organisers can edit their own drafts" on public.events;
create policy "Organisers can edit their own drafts"
    on public.events
    for update
    to authenticated
    using (organiser_id = (select auth.uid()) and status = 'draft')
    with check (
        organiser_id = (select auth.uid())
        and status in ('draft', 'submitted')
    );

drop policy if exists "Organisers can delete their own drafts" on public.events;
create policy "Organisers can delete their own drafts"
    on public.events
    for delete
    to authenticated
    using (organiser_id = (select auth.uid()) and status = 'draft');
