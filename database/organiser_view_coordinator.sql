-- Let an Organiser read the profile of the Coordinator assigned to one of
-- their events, so My Events can show the Coordinator's name.
--
-- Without this, profiles_select_own only lets a user read their own
-- profile, so the name lookup came back empty and the page showed
-- "Not assigned yet" even when a Coordinator was assigned.
--
-- Policies work on whole rows: the Organiser can also read that
-- Coordinator's contact_number and organization. This was judged acceptable:
-- an Organiser may need to contact their Coordinator.

drop policy if exists "Organisers can view their events' coordinators"
    on public.profiles;
create policy "Organisers can view their events' coordinators"
    on public.profiles
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.events
            where public.events.coordinator_id = profiles.id
              and public.events.organiser_id = (select auth.uid())
        )
    );
