-- ConnectSphere VENUES entity.
-- This file is intentionally limited to the VENUES table and its
-- Create Venue Profile integrity and authorization requirements.

create table public.venues (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    location text,
    capacity integer not null,
    facilities jsonb,
    accessibility jsonb,
    layouts jsonb not null,
    operating_hours jsonb not null,

    constraint venues_name_not_blank
        check (length(btrim(name)) > 0),
    constraint venues_capacity_positive
        check (capacity > 0)
);

create or replace function public.validate_venue_layouts(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
    layout jsonb;
    layout_name text;
    seen_names text[] := array[]::text[];
begin
    if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) = 0 then
        return false;
    end if;

    for layout in select jsonb_array_elements(value)
    loop
        if jsonb_typeof(layout) <> 'object'
            or jsonb_typeof(layout -> 'name') <> 'string'
            or length(btrim(layout ->> 'name')) = 0
            or jsonb_typeof(layout -> 'capacity') <> 'number'
            or (layout ->> 'capacity') !~ '^[0-9]+$'
            or (layout ->> 'capacity')::numeric <= 0
        then
            return false;
        end if;

        layout_name := lower(btrim(layout ->> 'name'));
        if layout_name = any(seen_names) then
            return false;
        end if;
        seen_names := array_append(seen_names, layout_name);
    end loop;

    return true;
end;
$$;

create or replace function public.validate_venue_layout_capacities(
    venue_capacity integer,
    value jsonb
)
returns boolean
language plpgsql
immutable
as $$
declare
    layout jsonb;
begin
    if venue_capacity is null
        or jsonb_typeof(value) <> 'array'
    then
        return false;
    end if;

    for layout in select jsonb_array_elements(value)
    loop
        if jsonb_typeof(layout) <> 'object'
            or (layout ->> 'capacity') !~ '^[0-9]+$'
            or (layout ->> 'capacity')::integer > venue_capacity
        then
            return false;
        end if;
    end loop;

    return true;
end;
$$;

create or replace function public.validate_venue_accessibility(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
    feature jsonb;
begin
    if value is null then
        return true;
    end if;

    if jsonb_typeof(value) <> 'array' then
        return false;
    end if;

    for feature in select jsonb_array_elements(value)
    loop
        if jsonb_typeof(feature) <> 'string' then
            return false;
        end if;
    end loop;

    return true;
end;
$$;

create or replace function public.validate_venue_operating_hours(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
    open_value text;
    close_value text;
begin
    if jsonb_typeof(value) <> 'object'
        or jsonb_typeof(value -> 'open') <> 'string'
        or jsonb_typeof(value -> 'close') <> 'string'
    then
        return false;
    end if;

    open_value := value ->> 'open';
    close_value := value ->> 'close';

    if open_value !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
        or close_value !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    then
        return false;
    end if;

    return open_value::time < close_value::time;
end;
$$;

alter table public.venues
    add constraint venues_layouts_valid
        check (public.validate_venue_layouts(layouts)),
    add constraint venues_accessibility_valid
        check (public.validate_venue_accessibility(accessibility)),
    add constraint venues_operating_hours_valid
        check (public.validate_venue_operating_hours(operating_hours)),
    add constraint venues_layout_capacities_within_venue
        check (public.validate_venue_layout_capacities(capacity, layouts));

create unique index venues_name_unique_case_insensitive
    on public.venues (lower(btrim(name)));

grant select on public.venues to authenticated;
grant insert on public.venues to authenticated;
grant update on public.venues to authenticated;

create function public.is_venue_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'venue_staff'
    );
$$;

revoke all on function public.is_venue_staff() from public;
grant execute on function public.is_venue_staff() to authenticated;

alter table public.venues enable row level security;

create policy "Authenticated users can view venues"
    on public.venues
    for select
    to authenticated
    using (true);

create policy "Venue staff can create venues"
    on public.venues
    for insert
    to authenticated
    with check (public.is_venue_staff());

create policy "Venue staff can update venues"
    on public.venues
    for update
    to authenticated
    using (public.is_venue_staff())
    with check (public.is_venue_staff());
