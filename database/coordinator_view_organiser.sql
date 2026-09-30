-- Let a Coordinator read the profile of the Organiser whose event is
-- assigned to them, so the review page can show the Organiser's name,
-- organisation and contact number.
--
-- Without this, profiles_select_own only lets a user read their own
-- profile. Drafts are left out: they are not assigned for review.

drop policy if exists "Coordinators can view their events' organisers"
    on public.profiles;
create policy "Coordinators can view their events' organisers"
    on public.profiles
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.events
            where public.events.organiser_id = profiles.id
              and public.events.coordinator_id = (select auth.uid())
              and public.events.status <> 'draft'
        )
    );
