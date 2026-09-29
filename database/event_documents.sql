-- Supporting files attached to an event request.
-- Object paths use the event UUID as their first folder:
-- <event-id>/<stored-file-name>.

create table if not exists public.event_documents (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    file_name text not null,
    storage_path text not null unique,
    created_at timestamptz not null default now(),

    constraint event_documents_file_name_not_blank
        check (length(btrim(file_name)) > 0)
);

create index if not exists event_documents_event_id_created_at_idx
    on public.event_documents (event_id, created_at);

grant select on public.event_documents to authenticated;
alter table public.event_documents enable row level security;

drop policy if exists "Coordinators can view assigned event documents"
    on public.event_documents;
drop policy if exists "Coordinators can view assigned reviewable event documents"
    on public.event_documents;
create policy "Coordinators can view assigned reviewable event documents"
    on public.event_documents
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.events
            where public.events.id = event_documents.event_id
              and public.events.coordinator_id = (select auth.uid())
              and public.events.status in ('submitted', 'under_review')
        )
    );

insert into storage.buckets (id, name, public)
values ('event-supporting-documents', 'event-supporting-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "Coordinators can download assigned event documents"
    on storage.objects;
drop policy if exists "Coordinators can download assigned reviewable event documents"
    on storage.objects;
create policy "Coordinators can download assigned reviewable event documents"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'event-supporting-documents'
        and exists (
            select 1
            from public.events
            where public.events.id::text = (storage.foldername(name))[1]
              and public.events.coordinator_id = (select auth.uid())
              and public.events.status in ('submitted', 'under_review')
        )
    );