-- ConnectSphere NOTIFICATIONS entity.
-- One row per notification shown to a user in the app. The same
-- notification is also emailed through SendGrid by
-- backend/services/notification_service.py.
--
-- Rows are created only by the backend, using the service-role key, which
-- skips row-level security. That is why there is no insert policy: no user
-- may create a notification for anyone, including themselves.

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    -- Optional: some notifications are not about a specific event.
    event_id uuid
        references public.events(id) on delete set null,
    type text not null,
    title text not null,
    body text not null,
    is_read boolean not null default false,
    created_at timestamptz not null default now(),

    constraint notifications_type_not_blank
        check (length(btrim(type)) > 0),

    constraint notifications_title_not_blank
        check (length(btrim(title)) > 0)
);

-- A user's notifications are always read newest first.
create index notifications_user_id_created_at_idx
    on public.notifications (user_id, created_at desc);

-- Row Level Security
-- A user can read only their own notifications.

alter table public.notifications enable row level security;

grant select on public.notifications to authenticated;

create policy "Users can view their own notifications"
    on public.notifications
    for select
    to authenticated
    using (user_id = (select auth.uid()));

-- A user can mark their own notifications as read. The column-level grant
-- means is_read is the only column they can change.
grant update (is_read) on public.notifications to authenticated;

create policy "Users can mark their own notifications read"
    on public.notifications
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));
