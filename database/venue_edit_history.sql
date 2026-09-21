-- Audit history for successful updates to public.venues.

create table public.venue_edit_history (
    id uuid primary key default gen_random_uuid(),
    venue_id uuid not null references public.venues(id),
    changed_by uuid not null references public.profiles(id),
    changed_at timestamptz not null default now(),
    changed_fields text[] not null,
    old_values jsonb not null,
    new_values jsonb not null,

    constraint venue_edit_history_fields_not_empty
        check (cardinality(changed_fields) > 0),
    constraint venue_edit_history_values_are_objects
        check (
            jsonb_typeof(old_values) = 'object'
            and jsonb_typeof(new_values) = 'object'
        )
);

create index venue_edit_history_venue_changed_at_idx
    on public.venue_edit_history (venue_id, changed_at desc);

alter table public.venue_edit_history enable row level security;

grant select on public.venue_edit_history to authenticated;

create policy "Venue staff can view venue edit history"
    on public.venue_edit_history
    for select
    to authenticated
    using (public.is_venue_staff());

create or replace function public.record_venue_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    changed_fields text[] := array[]::text[];
    old_values jsonb := '{}'::jsonb;
    new_values jsonb := '{}'::jsonb;
begin
    if old.name is distinct from new.name then
        changed_fields := array_append(changed_fields, 'name');
        old_values := old_values || jsonb_build_object('name', old.name);
        new_values := new_values || jsonb_build_object('name', new.name);
    end if;

    if old.location is distinct from new.location then
        changed_fields := array_append(changed_fields, 'location');
        old_values := old_values || jsonb_build_object('location', old.location);
        new_values := new_values || jsonb_build_object('location', new.location);
    end if;

    if old.capacity is distinct from new.capacity then
        changed_fields := array_append(changed_fields, 'capacity');
        old_values := old_values || jsonb_build_object('capacity', old.capacity);
        new_values := new_values || jsonb_build_object('capacity', new.capacity);
    end if;

    if old.facilities is distinct from new.facilities then
        changed_fields := array_append(changed_fields, 'facilities');
        old_values := old_values || jsonb_build_object('facilities', old.facilities);
        new_values := new_values || jsonb_build_object('facilities', new.facilities);
    end if;

    if old.accessibility is distinct from new.accessibility then
        changed_fields := array_append(changed_fields, 'accessibility');
        old_values := old_values || jsonb_build_object('accessibility', old.accessibility);
        new_values := new_values || jsonb_build_object('accessibility', new.accessibility);
    end if;

    if old.layouts is distinct from new.layouts then
        changed_fields := array_append(changed_fields, 'layouts');
        old_values := old_values || jsonb_build_object('layouts', old.layouts);
        new_values := new_values || jsonb_build_object('layouts', new.layouts);
    end if;

    if old.operating_hours is distinct from new.operating_hours then
        changed_fields := array_append(changed_fields, 'operating_hours');
        old_values := old_values || jsonb_build_object('operating_hours', old.operating_hours);
        new_values := new_values || jsonb_build_object('operating_hours', new.operating_hours);
    end if;

    if cardinality(changed_fields) > 0 then
        insert into public.venue_edit_history (
            venue_id,
            changed_by,
            changed_fields,
            old_values,
            new_values
        )
        values (
            new.id,
            auth.uid(),
            changed_fields,
            old_values,
            new_values
        );
    end if;

    return new;
end;
$$;

revoke all on function public.record_venue_edit() from public;

create trigger venues_record_edit
    after update on public.venues
    for each row
    execute function public.record_venue_edit();
