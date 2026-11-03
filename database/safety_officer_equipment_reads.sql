-- Safety Officers review an event's allocated equipment, so they need to read
-- equipment requests and the items booked against them. Read-only: they
-- cannot add, change or remove equipment.
-- Run after equipment_requests.sql and equipment_bookings.sql.

drop policy if exists "Safety Officers can view equipment requests"
    on public.equipment_requests;
create policy "Safety Officers can view equipment requests"
    on public.equipment_requests for select
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where profiles.id = (select auth.uid())
              and profiles.role = 'safety_officer'
        )
    );

drop policy if exists "Safety Officers can view equipment bookings"
    on public.equipment_bookings;
create policy "Safety Officers can view equipment bookings"
    on public.equipment_bookings for select
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where profiles.id = (select auth.uid())
              and profiles.role = 'safety_officer'
        )
    );
