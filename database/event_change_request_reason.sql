-- Upgrade an existing event_change_requests table with the reason field.
-- Run this only if event_change_requests.sql has already been applied.

alter table public.event_change_requests
    add column if not exists reason_for_change text;

-- Existing requests predate this field; retain them with a clear legacy value.
update public.event_change_requests
set reason_for_change = 'Not provided for this earlier request'
where reason_for_change is null;

alter table public.event_change_requests
    alter column reason_for_change set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'event_change_requests_reason_not_blank'
          and conrelid = 'public.event_change_requests'::regclass
    ) then
        alter table public.event_change_requests
            add constraint event_change_requests_reason_not_blank
            check (length(btrim(reason_for_change)) > 0);
    end if;
end;
$$;

-- Keep the installed RPC in sync with the new required reason column. The
-- earlier version of this function inserted proposals without this field.
create or replace function public.submit_event_change_request(
    p_event_id uuid,
    p_organiser_id uuid,
    p_changes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_event public.events%rowtype;
    change_request_id uuid;
    new_category_other text;
    new_location text;
    new_layout text;
    new_accessibility text;
    new_equipment text;
begin
    if auth.uid() is null
        or auth.uid() <> p_organiser_id
        or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can submit a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = p_organiser_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status not in ('under_review', 'planning', 'confirmed') then
        raise exception 'Event cannot be changed in its current status';
    end if;

    if exists (
        select 1 from public.event_change_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending change request already exists';
    end if;

    new_category_other := nullif(btrim(p_changes->>'category_other'), '');
    new_location := case
        when lower(btrim(p_changes->>'location_preference')) = 'nil' then null
        else nullif(btrim(p_changes->>'location_preference'), '')
    end;
    new_layout := case
        when lower(btrim(p_changes->>'layout_preference')) = 'nil' then null
        else nullif(btrim(p_changes->>'layout_preference'), '')
    end;
    new_accessibility := case
        when lower(btrim(p_changes->>'accessibility_requirements')) = 'nil' then null
        else nullif(btrim(p_changes->>'accessibility_requirements'), '')
    end;
    new_equipment := case
        when lower(btrim(p_changes->>'equipment_requirements')) = 'nil' then null
        else nullif(btrim(p_changes->>'equipment_requirements'), '')
    end;

    if current_event.name is not distinct from p_changes->>'name'
        and current_event.description is not distinct from p_changes->>'description'
        and current_event.purpose is not distinct from p_changes->>'purpose'
        and current_event.category::text is not distinct from p_changes->>'category'
        and current_event.category_other is not distinct from new_category_other
        and date_trunc('minute', current_event.start_time) is not distinct from date_trunc('minute', (p_changes->>'start_time')::timestamptz)
        and date_trunc('minute', current_event.end_time) is not distinct from date_trunc('minute', (p_changes->>'end_time')::timestamptz)
        and current_event.expected_attendance is not distinct from (p_changes->>'expected_attendance')::integer
        and (case when lower(btrim(current_event.location_preference)) = 'nil' then null else btrim(current_event.location_preference) end) is not distinct from new_location
        and (case when lower(btrim(current_event.layout_preference)) = 'nil' then null else btrim(current_event.layout_preference) end) is not distinct from new_layout
        and (case when lower(btrim(current_event.accessibility_requirements)) = 'nil' then null else btrim(current_event.accessibility_requirements) end) is not distinct from new_accessibility
        and (case when lower(btrim(current_event.equipment_requirements)) = 'nil' then null else btrim(current_event.equipment_requirements) end) is not distinct from new_equipment then
        raise exception 'No event details were changed';
    end if;

    insert into public.event_change_requests (
        event_id, organiser_id, event_status_before_request,
        name, description, reason_for_change, purpose, category,
        category_other, start_time, end_time, expected_attendance,
        location_preference, layout_preference, accessibility_requirements,
        equipment_requirements
    ) values (
        p_event_id, p_organiser_id, current_event.status,
        p_changes->>'name', p_changes->>'description',
        p_changes->>'reason_for_change', p_changes->>'purpose',
        p_changes->>'category', new_category_other,
        (p_changes->>'start_time')::timestamptz,
        (p_changes->>'end_time')::timestamptz,
        (p_changes->>'expected_attendance')::integer,
        new_location, new_layout, new_accessibility, new_equipment
    ) returning id into change_request_id;

    update public.events
    set status = 'change_requested'
    where id = p_event_id;

    return change_request_id;
end;
$$;

revoke all on function public.submit_event_change_request(uuid, uuid, jsonb)
    from public;
grant execute on function public.submit_event_change_request(uuid, uuid, jsonb)
    to authenticated;
