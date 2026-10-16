-- Apply after equipment_requests.sql when its earlier version has already
-- been installed. This updates policies and validation without deleting rows.

alter table public.equipment_requests
    drop constraint if exists equipment_requests_status_valid;

alter table public.equipment_requests
    add constraint equipment_requests_status_valid
        check (status in (
            'Pending Technical Approval',
            'Approved',
            'Rejected'
        ));

drop policy if exists "Coordinators and Tech Support can view equipment requests"
    on public.equipment_requests;
create policy "Coordinators and Tech Support can view equipment requests"
    on public.equipment_requests
    for select
    to authenticated
    using (
        public.is_tech_support()
        or (
            public.is_coordinator()
            and exists (
                select 1
                from public.events
                where public.events.id = public.equipment_requests.event_id
                  and public.events.coordinator_id = (select auth.uid())
            )
        )
    );

drop policy if exists "Coordinators and Tech Support can view requested items"
    on public.equipment_request_items;
create policy "Coordinators and Tech Support can view requested items"
    on public.equipment_request_items
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.equipment_requests
            where public.equipment_requests.id = request_id
              and (
                  public.is_tech_support()
                  or (
                      public.is_coordinator()
                      and exists (
                          select 1
                          from public.events
                          where public.events.id = public.equipment_requests.event_id
                            and public.events.coordinator_id = (select auth.uid())
                      )
                  )
              )
        )
    );

create or replace function public.tech_support_has_equipment_request(
    p_event_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_tech_support() then
        return false;
    end if;

    return exists (
        select 1
        from public.equipment_requests
        where public.equipment_requests.event_id = p_event_id
    );
end;
$$;

revoke all on function public.tech_support_has_equipment_request(uuid) from public;
grant execute on function public.tech_support_has_equipment_request(uuid) to authenticated;

drop policy if exists "Tech Support can view events with equipment requests"
    on public.events;
create policy "Tech Support can view events with equipment requests"
    on public.events
    for select
    to authenticated
    using (public.tech_support_has_equipment_request(public.events.id));

grant update (status) on public.equipment_requests to authenticated;

drop policy if exists "Technical Support can review equipment requests"
    on public.equipment_requests;
create policy "Technical Support can review equipment requests"
    on public.equipment_requests
    for update
    to authenticated
    using (
        public.is_tech_support()
        and status = 'Pending Technical Approval'
    )
    with check (
        public.is_tech_support()
        and status in ('Approved', 'Rejected')
    );

create or replace function public.submit_equipment_request(
    p_event_id uuid,
    p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request_id uuid;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
        raise exception 'At least one equipment item is required.'
            using errcode = '22023';
    end if;
    if jsonb_array_length(p_items) = 0 then
        raise exception 'At least one equipment item is required.'
            using errcode = '22023';
    end if;

    if not exists (
        select 1
        from public.events
        where public.events.id = p_event_id
          and public.events.coordinator_id = auth.uid()
          and public.events.status in ('planning', 'confirmed')
    ) then
        raise exception 'Event not found, not assigned to you, or not eligible for an equipment request.'
            using errcode = 'P0002';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        where item.equipment_id is null or item.quantity is null or item.quantity <= 0
    ) then
        raise exception 'Every equipment item must have a positive quantity.'
            using errcode = '22023';
    end if;

    if exists (
        select item.equipment_id
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        group by item.equipment_id
        having count(*) > 1
    ) then
        raise exception 'Each equipment item can only be listed once.'
            using errcode = '23505';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        left join public.equipment on public.equipment.id = item.equipment_id
        where public.equipment.id is null
           or public.equipment.maintenance_status <> 'Functional'
    ) then
        raise exception 'Requested equipment must exist and be functional.'
            using errcode = '23503';
    end if;

    insert into public.equipment_requests (event_id, coordinator_id)
    values (p_event_id, auth.uid())
    returning id into v_request_id;

    insert into public.equipment_request_items (request_id, equipment_id, quantity)
    select v_request_id, item.equipment_id, item.quantity
    from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer);

    return v_request_id;
end;
$$;

revoke all on function public.submit_equipment_request(uuid, jsonb) from public;
grant execute on function public.submit_equipment_request(uuid, jsonb) to authenticated;
