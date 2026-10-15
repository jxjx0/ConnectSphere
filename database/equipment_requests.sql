-- Equipment requests submitted by the Coordinator for an assigned event.
-- Each request and its item quantities are written atomically by the RPC
-- function below.

create table public.equipment_requests (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id),
    coordinator_id uuid not null references public.profiles(id),
    status text not null default 'Pending Technical Approval',
    created_at timestamptz not null default now(),

    constraint equipment_requests_status_valid
        check (status = 'Pending Technical Approval')
);

create table public.equipment_request_items (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null
        references public.equipment_requests(id) on delete cascade,
    equipment_id uuid not null references public.equipment(id),
    quantity integer not null check (quantity > 0),

    constraint equipment_request_items_unique_equipment
        unique (request_id, equipment_id)
);

create index equipment_requests_event_id_idx
    on public.equipment_requests (event_id);

create index equipment_requests_coordinator_id_idx
    on public.equipment_requests (coordinator_id);

create or replace function public.is_tech_support()
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
          and public.profiles.role = 'tech_support'
    );
$$;

revoke all on function public.is_tech_support() from public;
grant execute on function public.is_tech_support() to authenticated;

alter table public.equipment_requests enable row level security;
alter table public.equipment_request_items enable row level security;

grant select on public.equipment_requests to authenticated;
grant select on public.equipment_request_items to authenticated;

create policy "Coordinators and Tech Support can view equipment requests"
    on public.equipment_requests
    for select
    to authenticated
    using (
        public.is_tech_support()
        or (
            public.is_coordinator()
            and coordinator_id = (select auth.uid())
        )
    );

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
                      and public.equipment_requests.coordinator_id = (select auth.uid())
                  )
              )
        )
    );

-- Technical Support needs event context to review equipment requirements.
create policy "Tech Support can view events with equipment requests"
    on public.events
    for select
    to authenticated
    using (
        public.is_tech_support()
        and exists (
            select 1
            from public.equipment_requests
            where public.equipment_requests.event_id = public.events.id
        )
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
          and public.events.status <> 'draft'
    ) then
        raise exception 'The event was not found or is not assigned to you.'
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
