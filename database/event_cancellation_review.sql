-- Coordinator review of an Organiser's event cancellation request.
-- Apply after event_cancellation_requests.sql, venue_tentative_holds.sql,
-- equipment_bookings.sql, event_change_requests.sql, and
-- create_event_safety_reviews.sql, event_registration.sql, and the
-- event_registrations table.
begin;

alter table public.event_cancellation_requests
    add column if not exists decision_reason text,
    add column if not exists decision_by uuid references public.profiles(id),
    add column if not exists decided_at timestamptz;

alter table public.events
    drop constraint if exists events_registration_closes_after_opens;
alter table public.events
    add constraint events_registration_closes_after_opens
    check (
        status = 'cancelled'
        or registration_opens_at is null
        or registration_closes_at is null
        or registration_closes_at > registration_opens_at
    );

create or replace function public.prevent_registration_for_cancelled_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    event_status text;
begin
    select status
    into event_status
    from public.events
    where id = new.event_id
    for share;

    if event_status = 'cancelled' then
        raise exception 'Registration is closed because this event was cancelled'
            using errcode = 'P0001';
    end if;

    return new;
end;
$$;

create or replace function public.prevent_reopening_cancelled_event_registration()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if old.status = 'cancelled' and (
        new.registration_opens_at is distinct from old.registration_opens_at
        or new.registration_closes_at is distinct from old.registration_closes_at
        or new.attendee_capacity is distinct from old.attendee_capacity
        or new.published_at is distinct from old.published_at
    ) then
        raise exception 'Registration cannot be changed after event cancellation'
            using errcode = 'P0001';
    end if;
    return new;
end;
$$;

alter table public.venue_blocks
    add column if not exists booking_id uuid
        references public.venue_bookings(booking_id) on delete cascade,
    add column if not exists source_booking_id uuid
        references public.venue_bookings(booking_id);
create index if not exists venue_blocks_booking_id_idx
    on public.venue_blocks(booking_id);
create index if not exists venue_blocks_booking_source_idx
    on public.venue_blocks(source_booking_id);

alter table public.equipment_requests
    drop constraint if exists equipment_requests_status_valid;
alter table public.equipment_requests
    add constraint equipment_requests_status_valid
    check (status in (
        'Pending Technical Approval', 'Approved', 'Rejected', 'Cancelled'
    ));

alter table public.event_change_requests
    drop constraint if exists event_change_requests_status_valid;
alter table public.event_change_requests
    add constraint event_change_requests_status_valid
    check (status in ('pending', 'approved', 'rejected', 'expired'));

alter table public.event_safety_reviews
    alter column safety_officer_id drop not null;
alter table public.event_safety_reviews
    drop constraint if exists event_safety_reviews_decision_check;
alter table public.event_safety_reviews
    add constraint event_safety_reviews_decision_check
    check (decision in ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'EXPIRED'));
alter table public.event_safety_reviews
    drop constraint if exists safety_reviews_reason_required_for_non_approval;
alter table public.event_safety_reviews
    add constraint safety_reviews_reason_required_for_non_approval
    check (
        decision in ('APPROVED', 'EXPIRED')
        or (reason is not null and length(btrim(reason)) > 0)
    );

alter table public.event_cancellation_requests
    drop constraint if exists event_cancellation_requests_decision_reason_not_blank;
alter table public.event_cancellation_requests
    add constraint event_cancellation_requests_decision_reason_not_blank
    check (
        decision_reason is null
        or length(btrim(decision_reason)) > 0
    );

drop policy if exists "Coordinators can view assigned event cancellation requests"
    on public.event_cancellation_requests;
create policy "Coordinators can view assigned event cancellation requests"
    on public.event_cancellation_requests
    for select
    to authenticated
    using (
        public.is_coordinator()
        and exists (
            select 1
            from public.events
            where public.events.id = event_cancellation_requests.event_id
              and public.events.coordinator_id = (select auth.uid())
        )
    );

create or replace function public.review_event_cancellation_request(
    p_event_id uuid,
    p_decision text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_request public.event_cancellation_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review cancellation requests';
    end if;

    if p_decision not in ('approve', 'reject') then
        raise exception 'Cancellation decision must be approve or reject';
    end if;

    if p_reason is null or length(btrim(p_reason)) = 0 then
        raise exception 'A decision reason is required';
    end if;

    select *
    into current_request
    from public.event_cancellation_requests
    where event_id = p_event_id
      and status = 'pending'
    for update;

    if not found then
        raise exception 'Cancellation request is no longer pending';
    end if;

    select *
    into current_event
    from public.events
    where id = p_event_id
      and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Cancellation request was not found for an event assigned to this Coordinator';
    end if;

    if current_event.status <> 'cancellation_requested' then
        raise exception 'This cancellation request is no longer pending';
    end if;

    if p_decision = 'approve' then
        if current_request.previous_event_status = 'awaiting_safety_check' then
            insert into public.event_safety_reviews (
                event_id,
                safety_officer_id,
                decision,
                notes,
                reason
            )
            values (
                p_event_id,
                null,
                'EXPIRED',
                'Automatically expired because the event was cancelled.',
                'Event cancellation was approved before the safety review.'
            );
        end if;

        update public.events
        set status = 'cancelled',
            updated_at = now(),
            registration_closes_at = now()
        where id = p_event_id
        returning * into current_event;

        update public.event_cancellation_requests
        set status = 'approved',
            decision_reason = btrim(p_reason),
            decision_by = auth.uid(),
            decided_at = now()
        where id = current_request.id
        returning * into current_request;

        update public.venue_tentative_holds
        set released_at = coalesce(released_at, now())
        where event_id = p_event_id
          and released_at is null;

        delete from public.venue_blocks
        where source_booking_id in (
            select booking_id
            from public.venue_bookings
            where event_id = p_event_id
        )
        or booking_id in (
            select booking_id
            from public.venue_bookings
            where event_id = p_event_id
        );

        update public.venue_bookings
        set status = 'CANCELLED'
        where event_id = p_event_id
          and status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY');

        delete from public.equipment_bookings
        where request_id in (
            select id
            from public.equipment_requests
            where event_id = p_event_id
        );

        update public.equipment_requests
        set status = 'Cancelled'
        where event_id = p_event_id
          and status <> 'Cancelled';

        update public.event_change_requests
        set status = 'expired',
            reviewed_at = now(),
            rejection_reason = null
        where event_id = p_event_id
          and status = 'pending';
    else
        update public.events
        set status = current_request.previous_event_status,
            updated_at = now()
        where id = p_event_id
        returning * into current_event;

        update public.event_cancellation_requests
        set status = 'rejected',
            decision_reason = btrim(p_reason),
            decision_by = auth.uid(),
            decided_at = now()
        where id = current_request.id
        returning * into current_request;
    end if;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'cancellation_request', to_jsonb(current_request)
    );
end;
$$;

revoke all on function public.review_event_cancellation_request(uuid, text, text) from public;
grant execute on function public.review_event_cancellation_request(uuid, text, text)
    to authenticated;

-- Also release resources for cancellations approved before this migration
-- gained cleanup behavior. Keep the event and request rows for audit history.
insert into public.event_safety_reviews (
    event_id,
    safety_officer_id,
    decision,
    notes,
    reason
)
select cancellation.event_id,
       null,
       'EXPIRED',
       'Automatically expired because the event was cancelled.',
       'Event cancellation was approved before the safety review.'
from public.event_cancellation_requests as cancellation
join public.events as event on event.id = cancellation.event_id
where cancellation.status = 'approved'
  and cancellation.previous_event_status = 'awaiting_safety_check'
  and event.status = 'cancelled'
  and not exists (
      select 1
      from public.event_safety_reviews as safety_review
      where safety_review.event_id = cancellation.event_id
        and safety_review.decision = 'EXPIRED'
  );

update public.venue_tentative_holds
set released_at = coalesce(released_at, now())
where event_id in (
    select request.event_id
    from public.event_cancellation_requests as request
    join public.events as event on event.id = request.event_id
    where request.status = 'approved'
      and event.status = 'cancelled'
)
and released_at is null;

delete from public.venue_blocks
where source_booking_id in (
    select booking_id
    from public.venue_bookings
    where event_id in (
        select request.event_id
        from public.event_cancellation_requests as request
        join public.events as event on event.id = request.event_id
        where request.status = 'approved'
          and event.status = 'cancelled'
    )
)
or booking_id in (
    select booking_id
    from public.venue_bookings
    where event_id in (
        select request.event_id
        from public.event_cancellation_requests as request
        join public.events as event on event.id = request.event_id
        where request.status = 'approved'
          and event.status = 'cancelled'
    )
);

update public.venue_bookings
set status = 'CANCELLED'
where event_id in (
    select request.event_id
    from public.event_cancellation_requests as request
    join public.events as event on event.id = request.event_id
    where request.status = 'approved'
      and event.status = 'cancelled'
)
and status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY');

delete from public.equipment_bookings
where request_id in (
    select id
    from public.equipment_requests
    where event_id in (
        select request.event_id
        from public.event_cancellation_requests as request
        join public.events as event on event.id = request.event_id
        where request.status = 'approved'
          and event.status = 'cancelled'
    )
);

update public.equipment_requests
set status = 'Cancelled'
where event_id in (
    select request.event_id
    from public.event_cancellation_requests as request
    join public.events as event on event.id = request.event_id
    where request.status = 'approved'
      and event.status = 'cancelled'
)
and status <> 'Cancelled';

update public.event_change_requests
set status = 'expired',
    reviewed_at = coalesce(reviewed_at, now()),
    rejection_reason = null
where status = 'pending'
  and event_id in (
      select request.event_id
      from public.event_cancellation_requests as request
      join public.events as event on event.id = request.event_id
      where request.status = 'approved'
        and event.status = 'cancelled'
  );

update public.events
set registration_closes_at = now()
where status = 'cancelled'
  and id in (
        select request.event_id
        from public.event_cancellation_requests as request
        where request.status = 'approved'
  )
  and (
        registration_closes_at is null
        or registration_closes_at > now()
  );

drop trigger if exists prevent_registration_for_cancelled_event
    on public.event_registrations;
create trigger prevent_registration_for_cancelled_event
    before insert or update of event_id
    on public.event_registrations
    for each row
    execute function public.prevent_registration_for_cancelled_event();

drop trigger if exists prevent_reopening_cancelled_event_registration
    on public.events;
create trigger prevent_reopening_cancelled_event_registration
    before update of registration_opens_at, registration_closes_at,
        attendee_capacity, published_at
    on public.events
    for each row
    execute function public.prevent_reopening_cancelled_event_registration();

commit;
