-- ADDED BY HAND, not part of the dump. If you regenerate this file with
-- `supabase db dump`, add this section and the one at the end back.
-- A dump does not include database roles, so the custom role this schema needs
-- is created here, matching the live project and
-- database/venue_booking_request_names.sql.
do $$
begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'venue_booking_name_reader') then
        create role venue_booking_name_reader nologin inherit nobypassrls;
    end if;
end
$$;

grant authenticated to venue_booking_name_reader;
grant venue_booking_name_reader to current_user;

-- This role owns a function in venue_private, which needs CREATE on that
-- schema while the file loads. It is removed again at the end of this file.
create schema if not exists venue_private;
grant create on schema venue_private to venue_booking_name_reader;
-- END OF ADDED SECTION




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "venue_private";


ALTER SCHEMA "venue_private" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."acknowledge_venue_hold_expiry"("p_hold_id" "uuid", "p_claim" timestamp with time zone) RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    update public.venue_tentative_holds set expiry_notified_at=now()
    where hold_id=p_hold_id and expiry_claimed_at=p_claim;
$$;


ALTER FUNCTION "public"."acknowledge_venue_hold_expiry"("p_hold_id" "uuid", "p_claim" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_session_change_request"("p_event_id" "uuid", "p_cancel_booking_ids" "uuid"[] DEFAULT ARRAY[]::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
    proposal public.event_change_request_sessions%rowtype;
    current_session public.event_sessions%rowtype;
    removed_ids uuid[];
    rebooked_ids uuid[] := array[]::uuid[];
    material boolean := false;
    status_before text;
    next_status text;
    cancelled_bookings jsonb;
    affected_bookings integer;
    affected_requests integer;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    -- Lock the event first, the same order every request function uses.
    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    select * into current_request
    from public.event_change_requests
    where event_id = p_event_id and status = 'pending'
    for update;

    if not found then
        raise exception 'Change request is no longer pending';
    end if;

    select coalesce(array_agg(session.id), array[]::uuid[]) into removed_ids
    from public.event_sessions as session
    where session.event_id = p_event_id
      and not exists (
          select 1 from public.event_change_request_sessions as kept
          where kept.change_request_id = current_request.id
            and kept.session_id = session.id
      );

    select * into current_session
    from public.event_sessions
    where id = any(removed_ids) and start_time <= now()
    limit 1;
    if found then
        raise exception '%: This session has already started and cannot be removed',
            current_session.name using errcode = '22023';
    end if;

    if cardinality(removed_ids) > 0 then
        material := true;
        rebooked_ids := rebooked_ids || removed_ids;
    end if;

    for proposal in
        select * from public.event_change_request_sessions
        where change_request_id = current_request.id
    loop
        if proposal.session_id is null then
            if proposal.start_time <= now() then
                raise exception '%: Start time must be in the future', proposal.name
                    using errcode = '22023';
            end if;
            insert into public.event_sessions (
                event_id, name, start_time, end_time, expected_attendance,
                location_preference, layout_preference, equipment_requirements
            ) values (
                p_event_id, proposal.name, proposal.start_time, proposal.end_time,
                proposal.expected_attendance, proposal.location_preference,
                proposal.layout_preference, proposal.equipment_requirements
            );
            material := true;
            continue;
        end if;

        select * into current_session
        from public.event_sessions
        where id = proposal.session_id and event_id = p_event_id
        for update;

        if not found then
            raise exception '%: This session no longer exists', proposal.name
                using errcode = '22023';
        end if;

        if current_session.name is distinct from proposal.name
           or date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
           or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time)
           or current_session.expected_attendance is distinct from proposal.expected_attendance
           or current_session.location_preference is distinct from proposal.location_preference
           or current_session.layout_preference is distinct from proposal.layout_preference
           or current_session.equipment_requirements is distinct from proposal.equipment_requirements then
            if current_session.start_time <= now() then
                raise exception '%: This session has already started and cannot be changed',
                    current_session.name using errcode = '22023';
            end if;

            if date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
               or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time)
               or current_session.expected_attendance is distinct from proposal.expected_attendance
               or current_session.location_preference is distinct from proposal.location_preference
               or current_session.layout_preference is distinct from proposal.layout_preference
               or current_session.equipment_requirements is distinct from proposal.equipment_requirements then
                material := true;
            end if;

            if date_trunc('minute', current_session.start_time) is distinct from date_trunc('minute', proposal.start_time)
               or date_trunc('minute', current_session.end_time) is distinct from date_trunc('minute', proposal.end_time) then
                rebooked_ids := array_append(rebooked_ids, current_session.id);
            end if;

            update public.event_sessions
            set name = proposal.name,
                start_time = proposal.start_time,
                end_time = proposal.end_time,
                expected_attendance = proposal.expected_attendance,
                location_preference = proposal.location_preference,
                layout_preference = proposal.layout_preference,
                equipment_requirements = proposal.equipment_requirements
            where id = current_session.id;
        end if;
    end loop;

    if current_event.accessibility_requirements
       is distinct from current_request.accessibility_requirements then
        material := true;
    end if;

    with cancelled as (
        update public.venue_bookings
        set status = 'CANCELLED',
            cancellation_reason = 'Its session was changed by an approved change request.',
            cancelled_at = now(),
            cancelled_by = auth.uid()
        where session_id = any(rebooked_ids)
          and status = 'PENDING_VENUE_APPROVAL'
          and booking_id = any(coalesce(p_cancel_booking_ids, array[]::uuid[]))
        returning booking_id, venue_id, session_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'booking_id', cancelled.booking_id,
        'venue_name', venue.name,
        'session_name', session.name
    )), '[]'::jsonb)
    into cancelled_bookings
    from cancelled
    left join public.venues as venue on venue.id = cancelled.venue_id
    left join public.event_sessions as session on session.id = cancelled.session_id;

    update public.venue_bookings
    set status = 'AFFECTED_BY_SESSION_CHANGE'
    where session_id = any(rebooked_ids) and status = 'APPROVED';
    get diagnostics affected_bookings = row_count;

    update public.equipment_requests
    set status = 'Affected by Session Change'
    where session_id = any(rebooked_ids)
      and status in ('Pending Technical Approval', 'Approved');
    get diagnostics affected_requests = row_count;

    delete from public.event_sessions where id = any(removed_ids);

    -- A material change to a confirmed event, or one in its safety check,
    -- needs replanning and a new safety check.
    status_before := current_event.status;
    next_status := case
        when material and current_event.status in ('awaiting_safety_check', 'confirmed') then 'planning'
        else current_event.status
    end;

    update public.event_change_requests
    set status = 'approved',
        closed_at = now(),
        closed_by = auth.uid(),
        decision_reason = null
    where id = current_request.id
    returning * into current_request;

    update public.events
    set name = current_request.name,
        description = current_request.description,
        purpose = current_request.purpose,
        category = current_request.category,
        category_other = current_request.category_other,
        accessibility_requirements = current_request.accessibility_requirements,
        status = next_status,
        updated_at = now()
    where id = p_event_id
    returning * into current_event;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request),
        'cancelled_bookings', cancelled_bookings,
        'affected_bookings', affected_bookings,
        'affected_equipment_requests', affected_requests,
        'returned_to_planning', status_before <> next_status
    );
end;
$$;


ALTER FUNCTION "public"."approve_session_change_request"("p_event_id" "uuid", "p_cancel_booking_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_forward_move_while_open"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if (old.status, new.status) in (
        ('under_review', 'planning'),
        ('planning', 'awaiting_safety_check'),
        ('planning', 'confirmed'),
        ('awaiting_safety_check', 'confirmed')
    ) and public.event_has_open_requests(new.id) then
        raise exception 'Close the open clarification, change or cancellation request before moving this event forward'
            using errcode = 'P0001';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."block_forward_move_while_open"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_equipment_request"("p_request_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.equipment_requests%rowtype;
    current_event public.events%rowtype;
    session_name text;
    session_start timestamptz;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can cancel equipment requests.'
            using errcode = '42501';
    end if;

    if p_reason is null or length(btrim(p_reason)) = 0 then
        raise exception 'Give a reason for cancelling.'
            using errcode = '22023';
    end if;

    select * into current_request
    from public.equipment_requests
    where id = p_request_id
    for update;

    select * into current_event
    from public.events
    where id = current_request.event_id
      and coordinator_id = auth.uid();

    if current_request.id is null or current_event.id is null then
        raise exception 'Equipment request was not found for an event assigned to you.'
            using errcode = 'P0002';
    end if;

    if current_event.status <> 'planning' then
        raise exception 'Equipment requests can only be cancelled while the event is in Planning.'
            using errcode = 'P0001';
    end if;

    if current_request.status not in (
        'Pending Technical Approval', 'Approved', 'Affected by Session Change'
    ) then
        raise exception 'This equipment request has already been rejected or cancelled.'
            using errcode = 'P0001';
    end if;

    select session.name, session.start_time
    into session_name, session_start
    from public.event_sessions as session
    where session.id = current_request.session_id;

    if coalesce(session_start, current_event.start_time) <= now() then
        raise exception 'This session has already started, so its equipment request cannot be cancelled.'
            using errcode = 'P0001';
    end if;

    update public.equipment_requests
    set status = 'Cancelled',
        cancellation_reason = btrim(p_reason),
        cancelled_at = now(),
        cancelled_by = auth.uid()
    where id = p_request_id
    returning * into current_request;

    delete from public.equipment_bookings
    where request_id = p_request_id;

    return to_jsonb(current_request) || jsonb_build_object(
        'event_name', current_event.name,
        'session_name', session_name
    );
end;
$$;


ALTER FUNCTION "public"."cancel_equipment_request"("p_request_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_venue_booking"("p_booking_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_booking public.venue_bookings%rowtype;
    current_event public.events%rowtype;
    session_name text;
    session_start timestamptz;
    venue_name text;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can cancel venue bookings.'
            using errcode = '42501';
    end if;

    if p_reason is null or length(btrim(p_reason)) = 0 then
        raise exception 'Give a reason for cancelling.'
            using errcode = '22023';
    end if;

    select * into current_booking
    from public.venue_bookings
    where booking_id = p_booking_id
    for update;

    select * into current_event
    from public.events
    where id = current_booking.event_id
      and coordinator_id = auth.uid();

    if current_booking.booking_id is null or current_event.id is null then
        raise exception 'Venue booking was not found for an event assigned to you.'
            using errcode = 'P0002';
    end if;

    if current_event.status <> 'planning' then
        raise exception 'Bookings can only be cancelled while the event is in Planning.'
            using errcode = 'P0001';
    end if;

    if current_booking.status not in (
        'PENDING_VENUE_APPROVAL', 'APPROVED', 'AFFECTED_BY_UNAVAILABILITY',
        'AFFECTED_BY_SESSION_CHANGE'
    ) then
        raise exception 'This venue booking has already been rejected or cancelled.'
            using errcode = 'P0001';
    end if;

    select session.name, session.start_time
    into session_name, session_start
    from public.event_sessions as session
    where session.id = current_booking.session_id;

    if coalesce(session_start, current_booking.start_at) <= now() then
        raise exception 'This session has already started, so its booking cannot be cancelled.'
            using errcode = 'P0001';
    end if;

    update public.venue_bookings
    set status = 'CANCELLED',
        cancellation_reason = btrim(p_reason),
        cancelled_at = now(),
        cancelled_by = auth.uid()
    where booking_id = p_booking_id
    returning * into current_booking;

    delete from public.venue_blocks
    where booking_id = p_booking_id;

    select venue.name into venue_name
    from public.venues as venue
    where venue.id = current_booking.venue_id;

    return to_jsonb(current_booking) || jsonb_build_object(
        'event_name', current_event.name,
        'session_name', session_name,
        'venue_name', venue_name
    );
end;
$$;


ALTER FUNCTION "public"."cancel_venue_booking"("p_booking_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_expired_venue_holds"() RETURNS "jsonb"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    with due as (
        select hold_id from public.venue_tentative_holds
        where expires_at<=now() and expiry_notified_at is null
            and (released_at is null or released_at>=expires_at)
            and (expiry_claimed_at is null or expiry_claimed_at<now()-interval '5 minutes')
        order by expires_at limit 100 for update skip locked
    ), claimed as (
        update public.venue_tentative_holds h set expiry_claimed_at=clock_timestamp()
        from due where h.hold_id=due.hold_id returning h.*
    ) select coalesce(jsonb_agg(jsonb_build_object(
        'hold_id',c.hold_id,'expiry_claimed_at',c.expiry_claimed_at,'completed_booking_id',c.completed_booking_id,
        'event_id',c.event_id,'event_name',e.name,'venue_name',v.name,'coordinator_id',e.coordinator_id
    )), '[]'::jsonb) from claimed c join public.events e on e.id=c.event_id join public.venues v on v.id=c.venue_id;
$$;


ALTER FUNCTION "public"."claim_expired_venue_holds"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_ended_events"() RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
    candidate_id uuid;
    completion_time timestamptz := now();
    completed_count integer := 0;
begin
    for candidate_id in
        select id from public.events
        where status = 'confirmed' and end_time < completion_time
        order by id
    loop
        perform 1 from public.events
        where id = candidate_id and status = 'confirmed'
        for update skip locked;
        if not found then
            continue;
        end if;

        update public.events
        set status = 'completed',
            completed_at = coalesce(completed_at, completion_time),
            updated_at = completion_time
        where id = candidate_id;
        completed_count := completed_count + 1;
    end loop;
    return completed_count;
end;
$$;


ALTER FUNCTION "public"."complete_ended_events"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organiser_id" "uuid" NOT NULL,
    "coordinator_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "purpose" "text",
    "category" "text",
    "start_time" timestamp with time zone,
    "end_time" timestamp with time zone,
    "expected_attendance" integer,
    "location_preference" "text",
    "layout_preference" "text",
    "accessibility_requirements" "text",
    "equipment_requirements" "text",
    "status" "text" DEFAULT 'under_review'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "category_other" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "safety_status" character varying(50) DEFAULT 'not_requested'::character varying,
    "safety_reviewed_by" "uuid",
    "registration_opens_at" timestamp with time zone,
    "registration_closes_at" timestamp with time zone,
    "attendee_capacity" integer,
    "published_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "safety_check_requested_at" timestamp with time zone,
    CONSTRAINT "events_attendee_capacity_positive" CHECK ((("attendee_capacity" IS NULL) OR ("attendee_capacity" > 0))),
    CONSTRAINT "events_category_other_matches_category" CHECK (((("category" = 'other'::"text") AND ("category_other" IS NOT NULL) AND ("length"("btrim"("category_other")) > 0)) OR (("category" <> 'other'::"text") AND ("category_other" IS NULL)))),
    CONSTRAINT "events_category_valid" CHECK (("category" = ANY (ARRAY['conference'::"text", 'workshop'::"text", 'seminar'::"text", 'meeting'::"text", 'networking'::"text", 'product_launch'::"text", 'training'::"text", 'social_event'::"text", 'ceremony'::"text", 'other'::"text"]))),
    CONSTRAINT "events_complete_unless_draft" CHECK ((("status" = 'draft'::"text") OR (("description" IS NOT NULL) AND ("purpose" IS NOT NULL) AND ("category" IS NOT NULL) AND ("start_time" IS NOT NULL) AND ("end_time" IS NOT NULL) AND ("expected_attendance" IS NOT NULL)))),
    CONSTRAINT "events_description_not_blank" CHECK (("length"("btrim"("description")) > 0)),
    CONSTRAINT "events_end_after_start" CHECK (("end_time" > "start_time")),
    CONSTRAINT "events_expected_attendance_positive" CHECK (("expected_attendance" > 0)),
    CONSTRAINT "events_name_not_blank" CHECK (("length"("btrim"("name")) > 0)),
    CONSTRAINT "events_purpose_not_blank" CHECK (("length"("btrim"("purpose")) > 0)),
    CONSTRAINT "events_registration_closes_after_opens" CHECK ((("status" = 'cancelled'::"text") OR ("registration_opens_at" IS NULL) OR ("registration_closes_at" IS NULL) OR ("registration_closes_at" > "registration_opens_at"))),
    CONSTRAINT "events_status_valid" CHECK (("status" = ANY (ARRAY['draft'::"text", 'under_review'::"text", 'planning'::"text", 'awaiting_safety_check'::"text", 'confirmed'::"text", 'completed'::"text", 'rejected'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") RETURNS SETOF "public"."events"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    blockers text[];
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can confirm event planning.'
            using errcode = '42501';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id
      and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found.'
            using errcode = 'P0002';
    end if;

    blockers := public.event_planning_blockers(p_event_id);
    if cardinality(blockers) > 0 then
        raise exception '%', blockers[1] using errcode = 'P0001';
    end if;

    return query
    update public.events
    set status = 'confirmed',
        updated_at = now()
    where id = p_event_id
      and coordinator_id = auth.uid()
      and status = 'planning'
    returning *;
end;
$$;


ALTER FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select (
        select count(*) from public.event_registrations r
        where r.event_id = e.id and r.status = 'registered'
    )::integer
    from public.events e
    where e.id = p_event_id
      and e.organiser_id = auth.uid();
$$;


ALTER FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_equipment_booking"("p_equipment_id" "uuid", "p_request_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_line_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.equipment_requests%rowtype;
    equipment_name text;
    equipment_maintenance_status text;
    equipment_kind text;
    event_name text;
    schedule_start timestamptz;
    schedule_end timestamptz;
    new_booking public.equipment_bookings%rowtype;
    line public.equipment_request_lines%rowtype;
    has_lines boolean;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can book equipment.'
            using errcode = '42501';
    end if;

    -- This lock also keeps two allocations from overfilling a line.
    select *
    into current_request
    from public.equipment_requests
    where id = p_request_id
    for update;

    if not found then
        raise exception 'Equipment request was not found.'
            using errcode = 'P0002';
    end if;

    if current_request.status <> 'Pending Technical Approval' then
        raise exception 'Only pending equipment requests can be allocated.'
            using errcode = 'P0001';
    end if;

    select equipment.name, equipment.maintenance_status, equipment.type
    into equipment_name, equipment_maintenance_status, equipment_kind
    from public.equipment as equipment
    where equipment.id = p_equipment_id
    for update;

    if not found then
        raise exception 'The requested equipment was not found.'
            using errcode = '23503';
    end if;

    if exists (
        select 1
        from public.equipment_bookings as booking
        where booking.request_id = current_request.id
          and booking.equipment_id = p_equipment_id
    ) then
        raise exception 'This requested item has already been allocated.'
            using errcode = 'P0001';
    end if;

    has_lines := exists (
        select 1
        from public.equipment_request_lines
        where request_id = current_request.id
    );

    if has_lines then
        if p_line_id is null then
            select *
            into line
            from public.equipment_request_lines
            where request_id = current_request.id
              and lower(item_name) = lower(equipment_kind);
        else
            select *
            into line
            from public.equipment_request_lines
            where request_id = current_request.id
              and id = p_line_id;
        end if;

        if not found then
            raise exception '% is not part of this request.', equipment_name
                using errcode = 'EQ001';
        end if;

        -- A different item can only stand in for something the catalogue lacks.
        if lower(line.item_name) <> lower(equipment_kind) and exists (
            select 1
            from public.equipment as equipment
            where lower(equipment.type) = lower(line.item_name)
        ) then
            raise exception '% is not a %, so it cannot fill this line.', equipment_name, line.item_name
                using errcode = 'EQ001';
        end if;

        if (
            select count(*)
            from public.equipment_bookings
            where line_id = line.id
        ) >= line.quantity then
            raise exception 'All % of % have already been allocated.', line.quantity, line.item_name
                using errcode = 'EQ001';
        end if;
    end if;

    select min(request_window.start_at), max(request_window.end_at)
    into schedule_start, schedule_end
    from public.equipment_request_window(current_request.id) as request_window;

    if schedule_start is null or p_start_at is null or p_end_at is null
       or p_end_at <= p_start_at
       or p_start_at is distinct from schedule_start
       or p_end_at is distinct from schedule_end then
        if current_request.session_id is null then
            raise exception 'Allocate equipment for the full event time, including venue setup and teardown buffers.'
                using errcode = '22023';
        end if;
        raise exception 'Allocate equipment for the full session time.'
            using errcode = '22023';
    end if;

    select event.name
    into event_name
    from public.events as event
    where event.id = current_request.event_id;

    if equipment_maintenance_status <> 'Functional' then
        return jsonb_build_object(
            'outcome', 'unavailable',
            'reason', 'maintenance',
            'equipment_status', equipment_maintenance_status,
            'coordinator_id', current_request.coordinator_id,
            'event_id', current_request.event_id,
            'event_name', event_name,
            'equipment_name', equipment_name
        );
    end if;

    begin
        insert into public.equipment_bookings (
            equipment_id,
            request_id,
            line_id,
            start_at,
            end_at,
            created_by
        )
        values (
            p_equipment_id,
            current_request.id,
            line.id,
            p_start_at,
            p_end_at,
            auth.uid()
        )
        returning * into new_booking;
    exception
        when exclusion_violation then
            return jsonb_build_object(
                'outcome', 'unavailable',
                'reason', 'overlap',
                'coordinator_id', current_request.coordinator_id,
                'event_id', current_request.event_id,
                'event_name', event_name,
                'equipment_name', equipment_name
            );
    end;

    return jsonb_build_object(
        'outcome', 'booked',
        'booking', jsonb_build_object(
            'id', new_booking.id,
            'equipment_id', new_booking.equipment_id,
            'request_id', new_booking.request_id,
            'line_id', new_booking.line_id,
            'start_at', new_booking.start_at,
            'end_at', new_booking.end_at
        )
    );
end;
$$;


ALTER FUNCTION "public"."create_equipment_booking"("p_equipment_id" "uuid", "p_request_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_line_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    select venue_private.create_venue_tentative_hold(p_venue_id,p_event_id,p_start_at,p_end_at,p_expires_at);
$$;


ALTER FUNCTION "public"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."default_equipment_type"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
    new.type := coalesce(nullif(btrim(new.type), ''), btrim(new.name));
    return new;
end;
$$;


ALTER FUNCTION "public"."default_equipment_type"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    booking_request_id uuid;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can remove equipment bookings.'
            using errcode = '42501';
    end if;

    select request.id
    into booking_request_id
    from public.equipment_bookings as booking
    join public.equipment_requests as request
      on request.id = booking.request_id
    where booking.id = p_booking_id
    for update of request;

    if not found then
        return false;
    end if;

    -- Bookings are managed by hand, so they can be removed whatever the
    -- request's status.
    delete from public.equipment_bookings
    where id = p_booking_id;

    return true;
end;
$$;


ALTER FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") RETURNS TABLE("booking_id" "uuid", "venue_name" "text", "room_layout" "text", "start_at" timestamp with time zone, "end_at" timestamp with time zone, "booking_status" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select
        booking.booking_id,
        venue.name,
        booking.room_layout::text,
        booking.effective_start_at,
        booking.effective_end_at,
        booking.status::text
    from public.venue_bookings as booking
    join public.venues as venue on venue.id = booking.venue_id
    where booking.event_id = p_event_id
      and upper(booking.status) not in ('REJECTED', 'CANCELLED')
      and booking.effective_start_at < booking.effective_end_at

    union all

    select
        null::uuid,
        null::text,
        null::text,
        event.start_time,
        event.end_time,
        'EVENT_SCHEDULE'::text
    from public.events as event
    where event.id = p_event_id
      and event.start_time is not null
      and event.end_time > event.start_time
      and not exists (
          select 1
          from public.venue_bookings as booking
          where booking.event_id = p_event_id
            and upper(booking.status) not in ('REJECTED', 'CANCELLED')
            and booking.effective_start_at < booking.effective_end_at
      );
$$;


ALTER FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."equipment_request_window"("p_request_id" "uuid") RETURNS TABLE("booking_id" "uuid", "venue_name" "text", "room_layout" "text", "start_at" timestamp with time zone, "end_at" timestamp with time zone, "booking_status" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.equipment_requests%rowtype;
begin
    select * into current_request
    from public.equipment_requests
    where id = p_request_id;

    if not found then
        return;
    end if;

    if current_request.session_id is null then
        return query
        select * from public.equipment_request_time_windows(current_request.event_id);
        return;
    end if;

    return query
    select
        booking.booking_id,
        venue.name,
        booking.room_layout::text,
        session.start_time,
        session.end_time,
        coalesce(booking.status::text, 'SESSION_SCHEDULE')
    from public.event_sessions as session
    left join lateral (
        select live.booking_id, live.venue_id, live.room_layout, live.status
        from public.venue_bookings as live
        where live.session_id = session.id
          and upper(live.status) not in ('REJECTED', 'CANCELLED')
        order by (upper(live.status) = 'APPROVED') desc, live.created_at
        limit 1
    ) as booking on true
    left join public.venues as venue on venue.id = booking.venue_id
    where session.id = current_request.session_id;
end;
$$;


ALTER FUNCTION "public"."equipment_request_window"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."event_has_open_requests"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select exists (select 1 from public.event_clarifications
                   where event_id = p_event_id and status = 'pending')
        or exists (select 1 from public.event_change_requests
                   where event_id = p_event_id and status = 'pending')
        or exists (select 1 from public.event_cancellation_requests
                   where event_id = p_event_id and status = 'pending');
$$;


ALTER FUNCTION "public"."event_has_open_requests"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") RETURNS "text"[]
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    blockers text[] := array[]::text[];
begin
    select * into current_event
    from public.events
    where id = p_event_id;

    if not found then
        return array['Event request was not found.']::text[];
    end if;

    if current_event.status <> 'planning' then
        blockers := array_append(
            blockers,
            'Only events in planning can be confirmed.'
        );
    end if;

    if public.event_has_open_requests(p_event_id) then
        blockers := array_append(
            blockers,
            'Close the open clarification, change or cancellation request before confirming this event.'
        );
    end if;

    if not exists (
        select 1
        from public.venue_bookings vb
        where vb.event_id = p_event_id
    ) then
        blockers := array_append(
            blockers,
            'Add at least one venue booking before confirming this event.'
        );
    elsif exists (
        select 1
        from public.venue_bookings vb
        where vb.event_id = p_event_id
          and upper(btrim(coalesce(vb.status, ''))) <> 'APPROVED'
    ) then
        blockers := array_append(
            blockers,
            'Every venue booking must be approved before confirming this event.'
        );
    end if;

    if nullif(btrim(current_event.equipment_requirements), '') is not null
       and not exists (
           select 1
           from public.equipment_requests er
           where er.event_id = p_event_id
       ) then
        blockers := array_append(
            blockers,
            'Technical requirements need an equipment request before confirmation.'
        );
    end if;

    if exists (
        select 1
        from public.equipment_requests er
        where er.event_id = p_event_id
          and upper(btrim(coalesce(er.status, ''))) <> 'APPROVED'
    ) then
        blockers := array_append(
            blockers,
            'Every equipment request must be approved before confirming this event.'
        );
    end if;

    if exists (
        select 1
        from public.equipment_requests er
        where er.event_id = p_event_id
          and not exists (
              select 1
              from public.equipment_request_items eri
              where eri.request_id = er.id
          )
    ) then
        blockers := array_append(
            blockers,
            'Approved equipment requests must include allocated equipment before confirmation.'
        );
    end if;

    return blockers;
end;
$$;


ALTER FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_open_requests_when_event_ends"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    update public.event_clarifications
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    update public.event_change_requests
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    update public.event_cancellation_requests
    set status = 'expired', closed_at = now()
    where event_id = new.id and status = 'pending';
    return new;
end;
$$;


ALTER FUNCTION "public"."expire_open_requests_when_event_ends"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    venue_data jsonb;
    equipment_data jsonb;
    blockers text[];
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can view event planning arrangements.'
            using errcode = '42501';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id
      and coordinator_id = auth.uid();

    if not found then
        raise exception 'Event request was not found.'
            using errcode = 'P0002';
    end if;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'booking_id', vb.booking_id,
                'venue_name', v.name,
                'location', v.location,
                'room_layout', vb.room_layout,
                'start_at', vb.start_at,
                'end_at', vb.end_at,
                'effective_start_at', vb.effective_start_at,
                'effective_end_at', vb.effective_end_at,
                'status', vb.status,
                'rejection_reason', vb.rejection_reason
            )
            order by vb.start_at
        ),
        '[]'::jsonb
    )
    into venue_data
    from public.venue_bookings vb
    left join public.venues v on v.id = vb.venue_id
    where vb.event_id = p_event_id;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', er.id,
                'status', er.status,
                'items', (
                    select coalesce(
                        jsonb_agg(
                            jsonb_build_object(
                                'equipment_id', eri.equipment_id,
                                'equipment_name', e.name,
                                'equipment_type', e.type,
                                'quantity', eri.quantity,
                                'maintenance_status', e.maintenance_status
                            )
                            order by e.name
                        ),
                        '[]'::jsonb
                    )
                    from public.equipment_request_items eri
                    left join public.equipment e on e.id = eri.equipment_id
                    where eri.request_id = er.id
                )
            )
            order by er.created_at
        ),
        '[]'::jsonb
    )
    into equipment_data
    from public.equipment_requests er
    where er.event_id = p_event_id;

    blockers := public.event_planning_blockers(p_event_id);

    return jsonb_build_object(
        'event_id', current_event.id,
        'event_status', current_event.status,
        'equipment_requirement', current_event.equipment_requirements,
        'venue_bookings', venue_data,
        'equipment_requests', equipment_data,
        'blockers', to_jsonb(blockers),
        'can_confirm', cardinality(blockers) = 0
    );
end;
$$;


ALTER FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tech_support_users"() RETURNS TABLE("id" "uuid", "email" "text", "raw_user_meta_data" "jsonb")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  select id, email, raw_user_meta_data from auth.users
  where raw_user_meta_data->>'role' = 'tech_support';
$$;


ALTER FUNCTION "public"."get_tech_support_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_venue_block_bookings"("p_venue_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    select venue_private.get_venue_block_bookings(p_venue_id);
$$;


ALTER FUNCTION "public"."get_venue_block_bookings"("p_venue_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) RETURNS TABLE("booking_id" "uuid", "event_name" "text", "session_name" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    select n.booking_id, n.event_name, n.session_name
    from venue_private.get_venue_booking_event_names(p_booking_ids) n;
$$;


ALTER FUNCTION "public"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_venue_hold_events"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    select venue_private.get_venue_hold_events();
$$;


ALTER FUNCTION "public"."get_venue_hold_events"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_venue_operational_blocks"("p_venue_ids" "uuid"[], "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles p where p.id=auth.uid() and p.role in ('venue_staff','coordinator')
    ) then
        raise exception 'Only venue staff and Coordinators can check venue blocks.' using errcode='42501';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object(
        'block_id',b.block_id,'venue_id',b.venue_id,'start_at',b.start_at,'end_at',b.end_at,
        'block_reason',b.block_reason,'source_booking_id',b.source_booking_id
    ) order by b.start_at,b.block_id),'[]'::jsonb) from public.venue_blocks b
        where b.venue_id=any(p_venue_ids) and b.start_at<p_end_at and p_start_at<b.end_at);
end; $$;


ALTER FUNCTION "public"."get_venue_operational_blocks"("p_venue_ids" "uuid"[], "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid" DEFAULT NULL::"uuid", "p_holds_only" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    select venue_private.get_venue_reservations(p_venue_ids,p_exclude_event_id,p_holds_only);
$$;


ALTER FUNCTION "public"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_coordinator"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'coordinator'
    );
$$;


ALTER FUNCTION "public"."is_coordinator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_organiser"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'organiser'
    );
$$;


ALTER FUNCTION "public"."is_organiser"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_tech_support"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'tech_support'
    );
$$;


ALTER FUNCTION "public"."is_tech_support"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_venue_staff"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select exists (
        select 1
        from public.profiles
        where public.profiles.id = (select auth.uid())
          and public.profiles.role = 'venue_staff'
    );
$$;


ALTER FUNCTION "public"."is_venue_staff"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_all_equipment_bookings"("p_from" timestamp with time zone, "p_to" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can view equipment bookings.'
            using errcode = '42501';
    end if;

    if p_from is null or p_to is null or p_to <= p_from then
        raise exception 'The calendar end time must be after its start time.'
            using errcode = '22023';
    end if;

    return coalesce((
        select jsonb_agg(
            jsonb_build_object(
                'id', booking.id,
                'equipment_id', equipment.id,
                'equipment_name', equipment.name,
                'equipment_type', equipment.type,
                'request_id', equipment_request.id,
                'request_status', equipment_request.status,
                'event_id', event.id,
                'event_name', event.name,
                'start_at', booking.start_at,
                'end_at', booking.end_at
            )
            order by booking.start_at, equipment.name, event.name
        )
        from public.equipment_bookings as booking
        join public.equipment as equipment
          on equipment.id = booking.equipment_id
        join public.equipment_requests as equipment_request
          on equipment_request.id = booking.request_id
        join public.events as event
          on event.id = equipment_request.event_id
        where booking.start_at < p_to
          and booking.end_at > p_from
    ), '[]'::jsonb);
end;
$$;


ALTER FUNCTION "public"."list_all_equipment_bookings"("p_from" timestamp with time zone, "p_to" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_equipment_bookings"("p_equipment_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can view equipment bookings.'
            using errcode = '42501';
    end if;

    return coalesce((
        select jsonb_agg(
            jsonb_build_object(
                'id', booking.id,
                'equipment_id', booking.equipment_id,
                'request_id', booking.request_id,
                'request_status', equipment_request.status,
                'event_id', event.id,
                'event_name', event.name,
                'start_at', booking.start_at,
                'end_at', booking.end_at
            )
            order by booking.start_at
        )
        from public.equipment_bookings as booking
        join public.equipment_requests as equipment_request
          on equipment_request.id = booking.request_id
        join public.events as event on event.id = equipment_request.event_id
        where booking.equipment_id = p_equipment_id
          and booking.start_at < p_to
          and booking.end_at > p_from
    ), '[]'::jsonb);
end;
$$;


ALTER FUNCTION "public"."list_equipment_bookings"("p_equipment_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_equipment_request_review_queue"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    request_queue jsonb;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can view equipment requests.'
            using errcode = '42501';
    end if;

    select coalesce(
        jsonb_agg(queue_row.request_data order by queue_row.status_order, queue_row.created_at desc),
        '[]'::jsonb
    )
    into request_queue
    from (
        select
            case
                when equipment_request.status = 'Pending Technical Approval' then 0
                else 1
            end as status_order,
            equipment_request.created_at,
            jsonb_build_object(
                'id', equipment_request.id,
                'event_id', event.id,
                'session_id', equipment_request.session_id,
                'coordinator_id', equipment_request.coordinator_id,
                'status', equipment_request.status,
                'request_details', equipment_request.request_details,
                'rejection_reason', equipment_request.rejection_reason,
                'created_at', equipment_request.created_at,
                'event', jsonb_build_object(
                    'id', event.id,
                    'name', event.name,
                    'start_time', event.start_time,
                    'end_time', event.end_time,
                    'organiser_name', organiser.full_name
                ),
                'session', case when session.id is null then null else jsonb_build_object(
                    'id', session.id,
                    'name', session.name,
                    'start_time', session.start_time,
                    'end_time', session.end_time,
                    'expected_attendance', session.expected_attendance,
                    'equipment_requirements', session.equipment_requirements
                ) end,
                'bookings', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'booking_id', booking_window.booking_id,
                            'venue_name', booking_window.venue_name,
                            'room_layout', booking_window.room_layout,
                            'start_at', booking_window.start_at,
                            'end_at', booking_window.end_at,
                            'booking_status', booking_window.booking_status
                        )
                        order by booking_window.start_at
                    )
                    from public.equipment_request_window(equipment_request.id) as booking_window
                ), '[]'::jsonb),
                'lines', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', line.id,
                            'item_name', line.item_name,
                            'quantity', line.quantity,
                            'specifics', line.specifics
                        )
                        order by line.item_name
                    )
                    from public.equipment_request_lines as line
                    where line.request_id = equipment_request.id
                ), '[]'::jsonb),
                'items', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', request_item.id,
                            'equipment_id', equipment.id,
                            'quantity', request_item.quantity,
                            'booked', exists (
                                select 1
                                from public.equipment_bookings as item_booking
                                where item_booking.request_id = equipment_request.id
                                  and item_booking.equipment_id = equipment.id
                            ),
                            'equipment', jsonb_build_object(
                                'id', equipment.id,
                                'name', equipment.name,
                                'type', equipment.type,
                                'maintenance_status', equipment.maintenance_status
                            )
                        )
                        order by equipment.name
                    )
                    from public.equipment_request_items as request_item
                    join public.equipment as equipment
                      on equipment.id = request_item.equipment_id
                    where request_item.request_id = equipment_request.id
                ), '[]'::jsonb),
                'equipment_bookings', coalesce((
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', item_booking.id,
                            'equipment_id', equipment.id,
                            'equipment_name', equipment.name,
                            'line_id', item_booking.line_id,
                            'start_at', item_booking.start_at,
                            'end_at', item_booking.end_at
                        )
                        order by item_booking.start_at, equipment.name
                    )
                    from public.equipment_bookings as item_booking
                    join public.equipment as equipment
                      on equipment.id = item_booking.equipment_id
                    where item_booking.request_id = equipment_request.id
                ), '[]'::jsonb)
            ) as request_data
        from public.equipment_requests as equipment_request
        join public.events as event
          on event.id = equipment_request.event_id
        join public.profiles as organiser
          on organiser.id = event.organiser_id
        left join public.event_sessions as session
          on session.id = equipment_request.session_id
        where (
            (
                nullif(btrim(equipment_request.request_details), '') is not null
                and equipment_request.request_details
                    <> 'No description was provided for this existing request.'
            )
            or exists (
                select 1
                from public.equipment_request_items as requested_item
                where requested_item.request_id = equipment_request.id
            )
        )
    ) as queue_row;

    return request_queue;
end;
$$;


ALTER FUNCTION "public"."list_equipment_request_review_queue"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") RETURNS TABLE("kind" "text", "session_id" "uuid", "status" "text", "venue_name" "text", "venue_location" "text", "venue_capacity" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select 'venue', b.session_id, b.status::text, v.name, v.location, v.capacity
    from public.venue_bookings b
    join public.venues v on v.id = b.venue_id
    join public.events e on e.id = b.event_id
    where b.event_id = p_event_id
      and e.organiser_id = auth.uid()
      and b.status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY')
    union all
    select 'equipment', r.session_id, r.status, null, null, null
    from public.equipment_requests r
    join public.events e on e.id = r.event_id
    where r.event_id = p_event_id
      and e.organiser_id = auth.uid()
      and r.status not in ('Rejected', 'Cancelled');
$$;


ALTER FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "event_id" "uuid", "attendee_id" "uuid", "full_name" "text", "email" "text", "contact_number" "text", "created_at" timestamp with time zone, "event_name" "text", "event_start_time" timestamp with time zone, "event_end_time" timestamp with time zone, "event_status" "text", "status" "text", "withdrawn_at" timestamp with time zone, "can_withdraw" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select
        r.id,
        r.event_id,
        r.attendee_id,
        r.full_name,
        r.email,
        r.contact_number,
        r.created_at,
        e.name,
        e.start_time,
        e.end_time,
        e.status,
        r.status,
        r.withdrawn_at,
        (r.status = 'registered'
         and e.status in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed')
         and e.start_time > now()) is true
    from public.event_registrations r
    join public.events e on e.id = r.event_id
    where r.attendee_id = auth.uid()
      and (p_registration_id is null or r.id = p_registration_id)
    order by r.created_at desc;
$$;


ALTER FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_published_events"("p_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "name" "text", "description" "text", "purpose" "text", "category" "text", "category_other" "text", "start_time" timestamp with time zone, "end_time" timestamp with time zone, "accessibility_requirements" "text", "registration_opens_at" timestamp with time zone, "registration_closes_at" timestamp with time zone, "attendee_capacity" integer, "spots_left" integer, "is_registered" boolean, "sessions" "jsonb", "status" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select
        e.id,
        e.name,
        e.description,
        e.purpose,
        e.category,
        e.category_other,
        e.start_time,
        e.end_time,
        e.accessibility_requirements,
        e.registration_opens_at,
        e.registration_closes_at,
        e.attendee_capacity,
        greatest(
            e.attendee_capacity - (
                select count(*) from public.event_registrations r
                where r.event_id = e.id and r.status = 'registered'
            ),
            0
        )::integer,
        exists (
            select 1 from public.event_registrations r
            where r.event_id = e.id and r.attendee_id = auth.uid()
              and r.status = 'registered'
        ),
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', s.id,
                    'name', s.name,
                    'start_time', s.start_time,
                    'end_time', s.end_time,
                    'venue_name', v.name,
                    'venue_location', v.location
                )
                order by s.start_time
            )
            from public.event_sessions s
            left join public.venue_bookings b
                on b.session_id = s.id and b.status = 'APPROVED'
            left join public.venues v on v.id = b.venue_id
            where s.event_id = e.id
        ), '[]'::jsonb),
        e.status
    from public.events e
    where auth.uid() is not null
      and (
          e.status = 'confirmed'
          or (p_event_id is not null and e.status = 'cancelled')
      )
      and e.published_at is not null
      and (p_event_id is null or e.id = p_event_id)
    order by e.start_time;
$$;


ALTER FUNCTION "public"."list_published_events"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_venue_block_bookings_affected"("p_venue_id" "uuid", "p_booking_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
    updated_bookings jsonb;
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can update affected venue bookings.'
            using errcode = '42501';
    end if;

    with changed as (
            update public.venue_bookings
            set status = 'AFFECTED_BY_UNAVAILABILITY'
            where venue_id = p_venue_id
                and booking_id = any(p_booking_ids)
                and status = 'APPROVED'
            returning booking_id, status
        )
    select coalesce(jsonb_agg(to_jsonb(changed) order by booking_id), '[]'::jsonb)
    into updated_bookings from changed;
    return updated_bookings;
end;
$$;


ALTER FUNCTION "public"."mark_venue_block_bookings_affected"("p_venue_id" "uuid", "p_booking_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_venue_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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

    if old.setup_time_minutes is distinct from new.setup_time_minutes then
        changed_fields := array_append(changed_fields, 'setup_time_minutes');
        old_values := old_values || jsonb_build_object('setup_time_minutes', old.setup_time_minutes);
        new_values := new_values || jsonb_build_object('setup_time_minutes', new.setup_time_minutes);
    end if;

    if old.turnaround_time_minutes is distinct from new.turnaround_time_minutes then
        changed_fields := array_append(changed_fields, 'turnaround_time_minutes');
        old_values := old_values || jsonb_build_object('turnaround_time_minutes', old.turnaround_time_minutes);
        new_values := new_values || jsonb_build_object('turnaround_time_minutes', new.turnaround_time_minutes);
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


ALTER FUNCTION "public"."record_venue_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    account_email text;
    registered_count integer;
    registration_id uuid;
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles
        where profiles.id = auth.uid() and profiles.role = 'attendee'
    ) then
        raise exception 'Only a signed-in attendee can register for an event';
    end if;

    select lower(btrim(users.email)) into account_email
    from auth.users
    where users.id = auth.uid();

    if account_email is null or account_email = '' then
        raise exception 'This account has no email address';
    end if;

    -- The lock makes registrations for the same event wait for each other,
    -- so the spot count below cannot be read twice before either insert.
    select * into current_event
    from public.events
    where events.id = p_event_id
      and events.status = 'confirmed'
      and events.published_at is not null
    for update;

    if not found then
        raise exception 'Event was not found';
    end if;

    if current_event.registration_opens_at is null
        or now() < current_event.registration_opens_at then
        raise exception 'Registration has not opened yet';
    end if;

    if current_event.registration_closes_at is null
        or now() >= current_event.registration_closes_at then
        raise exception 'Registration has closed';
    end if;

    if exists (
        select 1 from public.event_registrations r
        where r.event_id = p_event_id and r.attendee_id = auth.uid()
          and r.status = 'registered'
    ) then
        raise exception 'This account is already registered for the event';
    end if;

    select count(*) into registered_count
    from public.event_registrations r
    where r.event_id = p_event_id and r.status = 'registered';

    if current_event.attendee_capacity is null
        or registered_count >= current_event.attendee_capacity then
        raise exception 'Event is full';
    end if;

    insert into public.event_registrations (
        event_id, attendee_id, full_name, email, contact_number
    )
    values (
        p_event_id,
        auth.uid(),
        btrim(p_full_name),
        account_email,
        nullif(btrim(p_contact_number), '')
    )
    returning event_registrations.id into registration_id;

    return registration_id;
end;
$$;


ALTER FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_completed_event_request"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
    event_status text;
begin
    if new.status <> 'pending' then
        return new;
    end if;

    select status into event_status from public.events
    where id = new.event_id for update;
    if not found then
        raise exception 'Event request was not found';
    end if;
    if event_status in ('completed', 'rejected', 'cancelled') then
        if tg_table_name = 'event_change_requests' then
            raise exception 'Event cannot be changed in its current status';
        elsif tg_table_name = 'event_clarifications' then
            raise exception 'Event cannot be clarified in its current status';
        end if;
        raise exception 'Event cannot be cancelled in its current status';
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."reject_completed_event_request"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.event_change_requests%rowtype;
    current_event public.events%rowtype;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only a Coordinator can review event changes';
    end if;

    if p_rejection_reason is null or length(btrim(p_rejection_reason)) = 0 then
        raise exception 'A reason is required to reject a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Change request was not found for an event assigned to this Coordinator';
    end if;

    update public.event_change_requests
    set status = 'rejected',
        decision_reason = btrim(p_rejection_reason),
        closed_at = now(),
        closed_by = auth.uid()
    where event_id = p_event_id and status = 'pending'
    returning * into current_request;

    if current_request.id is null then
        raise exception 'Change request is no longer pending';
    end if;

    update public.events
    set updated_at = now()
    where id = p_event_id
    returning * into current_event;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'change_request', to_jsonb(current_request)
    );
end;
$$;


ALTER FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text",
    "start_time" timestamp with time zone,
    "end_time" timestamp with time zone,
    "expected_attendance" integer,
    "location_preference" "text",
    "layout_preference" "text",
    "equipment_requirements" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_sessions_attendance_positive" CHECK ((("expected_attendance" IS NULL) OR ("expected_attendance" > 0))),
    CONSTRAINT "event_sessions_end_after_start" CHECK ((("start_time" IS NULL) OR ("end_time" IS NULL) OR ("end_time" > "start_time"))),
    CONSTRAINT "event_sessions_name_not_blank" CHECK ((("name" IS NULL) OR ("length"("btrim"("name")) > 0)))
);


ALTER TABLE "public"."event_sessions" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_draft_sessions"("p_event_id" "uuid", "p_sessions" "jsonb") RETURNS SETOF "public"."event_sessions"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
    delete from public.event_sessions where event_id = p_event_id;
    return query
    insert into public.event_sessions (
        event_id, name, start_time, end_time, expected_attendance,
        location_preference, layout_preference, equipment_requirements)
    select p_event_id, s.name, s.start_time, s.end_time, s.expected_attendance,
           s.location_preference, s.layout_preference, s.equipment_requirements
    from jsonb_to_recordset(p_sessions) as s(
        name text, start_time timestamptz, end_time timestamptz,
        expected_attendance integer, location_preference text,
        layout_preference text, equipment_requirements text)
    returning *;
end;
$$;


ALTER FUNCTION "public"."replace_draft_sessions"("p_event_id" "uuid", "p_sessions" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_coordinator_id
        or not public.is_coordinator() then
        raise exception 'Only the assigned Coordinator can request clarification';
    end if;

    if p_notes is null or length(btrim(p_notes)) not between 1 and 5000 then
        raise exception 'Clarification notes must contain between 1 and 5000 characters';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = p_coordinator_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;
    if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
        raise exception 'Event cannot be clarified in its current status';
    end if;
    if exists (select 1 from public.event_clarifications
               where event_id = p_event_id and status = 'pending') then
        raise exception 'A clarification is already waiting for a response';
    end if;
    if exists (select 1 from public.event_cancellation_requests
               where event_id = p_event_id and status = 'pending') then
        raise exception 'Review the pending cancellation request first';
    end if;

    insert into public.event_clarifications (
        event_id, organiser_id, coordinator_id, coordinator_notes
    ) values (
        p_event_id, current_event.organiser_id, p_coordinator_id, btrim(p_notes)
    ) returning id into clarification_id;

    update public.events set updated_at = now() where id = p_event_id;

    return clarification_id;
end;
$$;


ALTER FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    clarification_id uuid;
begin
    if auth.uid() is null
        or auth.uid() <> p_organiser_id
        or not public.is_organiser() then
        raise exception 'Only the signed-in Organiser can respond to clarification';
    end if;

    if p_response is null or length(btrim(p_response)) not between 1 and 5000 then
        raise exception 'Your response must contain between 1 and 5000 characters';
    end if;

    perform 1 from public.events
    where id = p_event_id and organiser_id = p_organiser_id
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    update public.event_clarifications
    set organiser_response = btrim(p_response),
        status = 'answered',
        closed_at = now(),
        closed_by = p_organiser_id
    where event_id = p_event_id and status = 'pending'
    returning id into clarification_id;

    if clarification_id is null then
        raise exception 'No clarification is awaiting a response';
    end if;

    update public.events set updated_at = now() where id = p_event_id;

    return clarification_id;
end;
$$;


ALTER FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."review_equipment_request"("p_request_id" "uuid", "p_decision" "text", "p_rejection_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_request public.equipment_requests%rowtype;
    reason text := nullif(btrim(p_rejection_reason), '');
    event_name text;
    session_name text;
begin
    if auth.uid() is null or not public.is_tech_support() then
        raise exception 'Only Technical Support can review equipment requests.'
            using errcode = '42501';
    end if;

    if p_decision is null or p_decision not in ('Approved', 'Rejected') then
        raise exception 'Decision must be Approved or Rejected.'
            using errcode = '22023';
    end if;

    if p_decision = 'Rejected' and (reason is null or length(reason) > 500) then
        raise exception 'Give a reason of up to 500 characters for rejecting this request.'
            using errcode = 'EQ001';
    end if;

    select *
    into current_request
    from public.equipment_requests
    where id = p_request_id
    for update;

    if not found then
        raise exception 'Equipment request was not found.'
            using errcode = 'P0002';
    end if;

    if current_request.status <> 'Pending Technical Approval' then
        raise exception 'This equipment request has already been reviewed.'
            using errcode = 'P0001';
    end if;

    if p_decision = 'Approved' and exists (
        select 1
        from public.equipment_request_lines as line
        where line.request_id = current_request.id
          and (
              select count(*)
              from public.equipment_bookings as booking
              where booking.line_id = line.id
          ) < line.quantity
    ) then
        raise exception 'Allocate all the requested equipment before approving this request.'
            using errcode = 'EQ001';
    end if;

    update public.equipment_requests
    set status = p_decision,
        rejection_reason = case when p_decision = 'Rejected' then reason end
    where id = current_request.id;

    select event.name into event_name
    from public.events as event
    where event.id = current_request.event_id;

    select session.name into session_name
    from public.event_sessions as session
    where session.id = current_request.session_id;

    -- The extra details let the backend tell the Coordinator.
    return jsonb_build_object(
        'id', current_request.id,
        'status', p_decision,
        'rejection_reason', case when p_decision = 'Rejected' then reason end,
        'coordinator_id', current_request.coordinator_id,
        'event_id', current_request.event_id,
        'event_name', event_name,
        'session_name', session_name
    );
end;
$$;


ALTER FUNCTION "public"."review_equipment_request"("p_request_id" "uuid", "p_decision" "text", "p_rejection_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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

    select * into current_event
    from public.events
    where id = p_event_id and coordinator_id = auth.uid()
    for update;

    if not found then
        raise exception 'Cancellation request was not found for an event assigned to this Coordinator';
    end if;

    update public.event_cancellation_requests
    set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
        decision_reason = btrim(p_reason),
        closed_by = auth.uid(),
        closed_at = now()
    where event_id = p_event_id and status = 'pending'
    returning * into current_request;

    if current_request.id is null then
        raise exception 'Cancellation request is no longer pending';
    end if;

    if p_decision = 'approve' then
        update public.events
        set status = 'cancelled',
            updated_at = now(),
            registration_closes_at = coalesce(registration_closes_at, now())
        where id = p_event_id
        returning * into current_event;

        update public.venue_tentative_holds
        set released_at = coalesce(released_at, now())
        where event_id = p_event_id
          and released_at is null;

        delete from public.venue_blocks
        where source_booking_id in (
            select booking_id from public.venue_bookings where event_id = p_event_id
        )
        or booking_id in (
            select booking_id from public.venue_bookings where event_id = p_event_id
        );

        update public.venue_bookings
        set status = 'CANCELLED'
        where event_id = p_event_id
          and status not in ('CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY');

        delete from public.equipment_bookings
        where request_id in (
            select id from public.equipment_requests where event_id = p_event_id
        );

        update public.equipment_requests
        set status = 'Cancelled'
        where event_id = p_event_id
          and status <> 'Cancelled';
    else
        update public.events
        set updated_at = now()
        where id = p_event_id
        returning * into current_event;
    end if;

    return jsonb_build_object(
        'event', to_jsonb(current_event),
        'cancellation_request', to_jsonb(current_request)
    );
end;
$$;


ALTER FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    total_venue_capacity integer;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can set up registration';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status in (
        'draft', 'under_review', 'rejected', 'completed',
        'cancellation_requested', 'cancelled'
    ) then
        raise exception 'Registration cannot be set up for an event in its current status';
    end if;

    if current_event.registration_closes_at is not null
        and current_event.registration_closes_at <= now() then
        raise exception 'Registration has already closed';
    end if;

    if p_closes_at <= p_opens_at then
        raise exception 'Registration must close after it opens';
    end if;

    if current_event.start_time is not null
        and p_closes_at > current_event.start_time then
        raise exception 'Registration must close before the event starts';
    end if;

    select sum(v.capacity) into total_venue_capacity
    from public.event_sessions s
    join public.venue_bookings b
        on b.session_id = s.id and b.status = 'APPROVED'
    join public.venues v on v.id = b.venue_id
    where s.event_id = p_event_id;

    if total_venue_capacity is not null
        and not exists (
            select 1 from public.event_sessions s
            where s.event_id = p_event_id
              and not exists (
                  select 1 from public.venue_bookings b
                  where b.session_id = s.id and b.status = 'APPROVED'
              )
        )
        and p_capacity > total_venue_capacity then
        raise exception 'Attendee capacity cannot exceed the combined venue capacity';
    end if;

    -- Publishing checks each approval itself rather than trusting the
    -- 'confirmed' status: a venue or equipment request can be affected
    -- after the Safety Officer approved the event.
    if p_publish then
        if exists (
            select 1 from public.event_sessions s
            where s.event_id = p_event_id
              and not exists (
                  select 1 from public.venue_bookings b
                  where b.session_id = s.id and b.status = 'APPROVED'
              )
        ) or not exists (
            select 1 from public.venue_bookings b
            where b.event_id = p_event_id and b.status = 'APPROVED'
        ) then
            raise exception 'Every session needs an approved venue before publishing';
        end if;

        if exists (
            select 1 from public.equipment_requests r
            where r.event_id = p_event_id
              and r.status not in ('Approved', 'Rejected', 'Cancelled')
        ) then
            raise exception 'Every equipment request must be approved before publishing';
        end if;

        if current_event.status <> 'confirmed'
            or coalesce((
                select decision from public.event_safety_reviews
                where event_id = p_event_id
                order by created_at desc
                limit 1
            ), '') <> 'APPROVED' then
            raise exception 'The Safety Officer must approve the event before publishing';
        end if;
    end if;

    update public.events
    set registration_opens_at = p_opens_at,
        registration_closes_at = p_closes_at,
        attendee_capacity = p_capacity,
        published_at = case
            when p_publish then coalesce(published_at, now())
            else published_at
        end
    where id = p_event_id;
end;
$$;


ALTER FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    new_request_id uuid;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_event_id is null
       or p_request_details is null
       or length(btrim(p_request_details)) = 0
       or p_items is null
       or jsonb_typeof(p_items) is distinct from 'array'
       then
        raise exception 'Select an event and describe the equipment needed.'
            using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(873204, hashtext(p_event_id::text));

    if exists (
        select 1
        from public.equipment_requests
        where event_id = p_event_id
    ) then
        raise exception 'An equipment request has already been submitted for this event.'
            using errcode = 'P0001';
    end if;

    if not exists (
        select 1
        from public.events
        where id = p_event_id
          and coordinator_id = auth.uid()
          and status in ('planning', 'confirmed')
    ) then
        raise exception 'Event not found, not assigned to you, or not eligible for an equipment request.'
            using errcode = 'P0002';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        where item.equipment_id is null
           or item.quantity is null
           or item.quantity <= 0
    ) then
        raise exception 'Every requested equipment item must have a positive quantity.'
            using errcode = '22023';
    end if;

    if exists (
        select equipment_id
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        group by equipment_id
        having count(*) > 1
    ) then
        raise exception 'Each equipment item can only be listed once.'
            using errcode = '23505';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        left join public.equipment as equipment
          on equipment.id = item.equipment_id
        where equipment.id is null
           or equipment.maintenance_status <> 'Functional'
    ) then
        raise exception 'Requested equipment must exist and be functional.'
            using errcode = '23503';
    end if;

    insert into public.equipment_requests (
        event_id,
        coordinator_id,
        request_details
    )
    values (p_event_id, auth.uid(), btrim(p_request_details))
    returning id into new_request_id;

    insert into public.equipment_request_items (request_id, equipment_id, quantity)
    select new_request_id, item.equipment_id, item.quantity
    from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer);

    return new_request_id;
end;
$$;


ALTER FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_session_id" "uuid", "p_items" "jsonb", "p_request_details" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    new_request_id uuid;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_event_id is null
       or p_session_id is null
       or p_request_details is null
       or length(btrim(p_request_details)) = 0
       or p_items is null
       or jsonb_typeof(p_items) is distinct from 'array'
       then
        raise exception 'Select a session and describe the equipment needed.'
            using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(873204, hashtext(p_session_id::text));

    if not exists (
        select 1
        from public.events
        where id = p_event_id
          and coordinator_id = auth.uid()
          and status in ('planning', 'confirmed')
    ) then
        raise exception 'Event not found, not assigned to you, or not eligible for an equipment request.'
            using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.event_sessions
        where id = p_session_id
          and event_id = p_event_id
    ) then
        raise exception 'The session does not belong to this event.'
            using errcode = '22023';
    end if;

    if exists (
        select 1
        from public.equipment_requests
        where session_id = p_session_id
          and status <> 'Cancelled'
    ) then
        raise exception 'An equipment request has already been submitted for this session.'
            using errcode = 'P0001';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        where item.equipment_id is null
           or item.quantity is null
           or item.quantity <= 0
    ) then
        raise exception 'Every requested equipment item must have a positive quantity.'
            using errcode = '22023';
    end if;

    if exists (
        select equipment_id
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        group by equipment_id
        having count(*) > 1
    ) then
        raise exception 'Each equipment item can only be listed once.'
            using errcode = '23505';
    end if;

    if exists (
        select 1
        from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer)
        left join public.equipment as equipment
          on equipment.id = item.equipment_id
        where equipment.id is null
           or equipment.maintenance_status <> 'Functional'
    ) then
        raise exception 'Requested equipment must exist and be functional.'
            using errcode = '23503';
    end if;

    insert into public.equipment_requests (
        event_id,
        session_id,
        coordinator_id,
        request_details
    )
    values (p_event_id, p_session_id, auth.uid(), btrim(p_request_details))
    returning id into new_request_id;

    insert into public.equipment_request_items (request_id, equipment_id, quantity)
    select new_request_id, item.equipment_id, item.quantity
    from jsonb_to_recordset(p_items) as item(equipment_id uuid, quantity integer);

    return new_request_id;
end;
$$;


ALTER FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_session_id" "uuid", "p_items" "jsonb", "p_request_details" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_equipment_request_lines"("p_event_id" "uuid", "p_session_id" "uuid", "p_lines" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    new_request_id uuid;
    summary text;
begin
    if auth.uid() is null or not public.is_coordinator() then
        raise exception 'Only Event Coordinators can submit equipment requests.'
            using errcode = '42501';
    end if;

    if p_event_id is null
       or p_session_id is null
       or jsonb_typeof(p_lines) is distinct from 'array'
       or jsonb_array_length(p_lines) = 0 then
        raise exception 'Select a session and add the equipment needed.'
            using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(873204, hashtext(p_session_id::text));

    if not exists (
        select 1
        from public.events
        where id = p_event_id
          and coordinator_id = auth.uid()
          and status in ('planning', 'confirmed')
    ) then
        raise exception 'Event not found, not assigned to you, or not eligible for an equipment request.'
            using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.event_sessions
        where id = p_session_id
          and event_id = p_event_id
    ) then
        raise exception 'The session does not belong to this event.'
            using errcode = '22023';
    end if;

    if exists (
        select 1
        from public.equipment_requests
        where session_id = p_session_id
          and status <> 'Cancelled'
    ) then
        raise exception 'An equipment request has already been submitted for this session.'
            using errcode = 'P0001';
    end if;

    -- A summary keeps every page that shows a request's description working.
    select string_agg(
        format(
            '%s x %s%s',
            line.quantity,
            btrim(line.item_name),
            coalesce(' (' || nullif(btrim(line.specifics), '') || ')', '')
        ),
        '; '
    )
    into summary
    from jsonb_to_recordset(p_lines) as line(item_name text, quantity integer, specifics text);

    insert into public.equipment_requests (
        event_id,
        session_id,
        coordinator_id,
        request_details
    )
    values (p_event_id, p_session_id, auth.uid(), summary)
    returning id into new_request_id;

    -- The table's constraints reject a blank name, a bad quantity or a repeat.
    insert into public.equipment_request_lines (request_id, item_name, quantity, specifics)
    select
        new_request_id,
        btrim(line.item_name),
        line.quantity,
        nullif(btrim(line.specifics), '')
    from jsonb_to_recordset(p_lines) as line(item_name text, quantity integer, specifics text);

    return new_request_id;
end;
$$;


ALTER FUNCTION "public"."submit_equipment_request_lines"("p_event_id" "uuid", "p_session_id" "uuid", "p_lines" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    cancellation_request_id uuid;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can request event cancellation';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if exists (
        select 1 from public.event_cancellation_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending cancellation request already exists';
    end if;

    if current_event.status not in ('planning', 'awaiting_safety_check', 'confirmed') then
        raise exception 'Event cannot be cancelled in its current status';
    end if;

    insert into public.event_cancellation_requests (event_id, organiser_id, reason)
    values (p_event_id, auth.uid(), btrim(p_reason))
    returning id into cancellation_request_id;

    update public.events set updated_at = now() where id = p_event_id;

    return cancellation_request_id;
end;
$$;


ALTER FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_session_change_request"("p_event_id" "uuid", "p_changes" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    current_event public.events%rowtype;
    change_request_id uuid;
    proposed jsonb;
    current_session public.event_sessions%rowtype;
    proposed_ids uuid[] := array[]::uuid[];
    proposed_id uuid;
    proposed_name text;
    proposed_start timestamptz;
    proposed_end timestamptz;
    sessions_changed boolean := false;
    new_category_other text;
    new_accessibility text;
begin
    if auth.uid() is null or not public.is_organiser() then
        raise exception 'Only the signed-in organiser can submit a change request';
    end if;

    select * into current_event
    from public.events
    where id = p_event_id and organiser_id = auth.uid()
    for update;

    if not found then
        raise exception 'Event request was not found';
    end if;

    if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
        raise exception 'Event cannot be changed in its current status';
    end if;

    if exists (
        select 1 from public.event_change_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'A pending change request already exists';
    end if;

    if exists (
        select 1 from public.event_cancellation_requests
        where event_id = p_event_id and status = 'pending'
    ) then
        raise exception 'Event cannot be changed while a cancellation request is pending';
    end if;

    if jsonb_typeof(p_changes->'sessions') is distinct from 'array'
       or jsonb_array_length(p_changes->'sessions') = 0 then
        raise exception 'Keep at least one session' using errcode = '22023';
    end if;

    for proposed in select * from jsonb_array_elements(p_changes->'sessions')
    loop
        proposed_id := nullif(proposed->>'session_id', '')::uuid;
        proposed_name := btrim(proposed->>'name');
        proposed_start := (proposed->>'start_time')::timestamptz;
        proposed_end := (proposed->>'end_time')::timestamptz;

        if proposed_id is null then
            sessions_changed := true;
            if proposed_start <= now() then
                raise exception '%: Start time must be in the future', proposed_name
                    using errcode = '22023';
            end if;
            continue;
        end if;

        if proposed_id = any(proposed_ids) then
            raise exception 'Each session can only be listed once' using errcode = '22023';
        end if;
        proposed_ids := array_append(proposed_ids, proposed_id);

        select * into current_session
        from public.event_sessions
        where id = proposed_id and event_id = p_event_id;

        if not found then
            raise exception 'A session does not belong to this event' using errcode = '22023';
        end if;

        if current_session.name is distinct from proposed_name
           or date_trunc('minute', current_session.start_time)
              is distinct from date_trunc('minute', proposed_start)
           or date_trunc('minute', current_session.end_time)
              is distinct from date_trunc('minute', proposed_end)
           or current_session.expected_attendance
              is distinct from (proposed->>'expected_attendance')::integer
           or current_session.location_preference
              is distinct from nullif(btrim(proposed->>'location_preference'), '')
           or current_session.layout_preference
              is distinct from nullif(btrim(proposed->>'layout_preference'), '')
           or current_session.equipment_requirements
              is distinct from nullif(btrim(proposed->>'equipment_requirements'), '') then
            sessions_changed := true;
            if current_session.start_time <= now() then
                raise exception '%: This session has already started and cannot be changed',
                    current_session.name using errcode = '22023';
            end if;
            if proposed_start <= now() then
                raise exception '%: Start time must be in the future', proposed_name
                    using errcode = '22023';
            end if;
        end if;
    end loop;

    select * into current_session
    from public.event_sessions
    where event_id = p_event_id
      and not (id = any(proposed_ids))
      and start_time <= now()
    limit 1;

    if found then
        raise exception '%: This session has already started and cannot be removed',
            current_session.name using errcode = '22023';
    end if;

    if exists (
        select 1 from public.event_sessions
        where event_id = p_event_id and not (id = any(proposed_ids))
    ) then
        sessions_changed := true;
    end if;

    new_category_other := nullif(btrim(p_changes->>'category_other'), '');
    new_accessibility := nullif(btrim(p_changes->>'accessibility_requirements'), '');

    if not sessions_changed
       and current_event.name is not distinct from btrim(p_changes->>'name')
       and current_event.description is not distinct from btrim(p_changes->>'description')
       and current_event.purpose is not distinct from btrim(p_changes->>'purpose')
       and current_event.category::text is not distinct from p_changes->>'category'
       and current_event.category_other is not distinct from new_category_other
       and current_event.accessibility_requirements is not distinct from new_accessibility then
        raise exception 'No event details were changed';
    end if;

    insert into public.event_change_requests (
        event_id, organiser_id,
        name, description, reason_for_change, purpose, category,
        category_other, accessibility_requirements,
        start_time, end_time, expected_attendance
    )
    select
        p_event_id, auth.uid(),
        btrim(p_changes->>'name'), btrim(p_changes->>'description'),
        btrim(p_changes->>'reason_for_change'), btrim(p_changes->>'purpose'),
        p_changes->>'category', new_category_other, new_accessibility,
        min((session->>'start_time')::timestamptz),
        max((session->>'end_time')::timestamptz),
        max((session->>'expected_attendance')::integer)
    from jsonb_array_elements(p_changes->'sessions') as session
    returning id into change_request_id;

    insert into public.event_change_request_sessions (
        change_request_id, session_id, name, start_time, end_time,
        expected_attendance, location_preference, layout_preference,
        equipment_requirements
    )
    select
        change_request_id,
        nullif(session->>'session_id', '')::uuid,
        btrim(session->>'name'),
        (session->>'start_time')::timestamptz,
        (session->>'end_time')::timestamptz,
        (session->>'expected_attendance')::integer,
        nullif(btrim(session->>'location_preference'), ''),
        nullif(btrim(session->>'layout_preference'), ''),
        nullif(btrim(session->>'equipment_requirements'), '')
    from jsonb_array_elements(p_changes->'sessions') as session;

    update public.events set updated_at = now() where id = p_event_id;

    return change_request_id;
end;
$$;


ALTER FUNCTION "public"."submit_session_change_request"("p_event_id" "uuid", "p_changes" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_event_from_sessions"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    target_event_id uuid := coalesce(new.event_id, old.event_id);
    first_start timestamptz;
    last_end timestamptz;
    largest_attendance integer;
begin
    select min(start_time), max(end_time), max(expected_attendance)
    into first_start, last_end, largest_attendance
    from public.event_sessions
    where event_id = target_event_id;

    if first_start >= last_end then
        first_start := null;
        last_end := null;
    end if;

    update public.events
    set start_time = first_start,
        end_time = last_end,
        expected_attendance = largest_attendance
    where id = target_event_id;
    return null;
end;
$$;


ALTER FUNCTION "public"."sync_event_from_sessions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."track_safety_check_request"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
    if new.status = 'awaiting_safety_check' then
        new.safety_check_requested_at := now();
    elsif new.status in ('planning', 'confirmed') then
        new.safety_check_requested_at := null;
    end if;
    return new;
end;
$$;


ALTER FUNCTION "public"."track_safety_check_request"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_venue_accessibility"("value" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
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


ALTER FUNCTION "public"."validate_venue_accessibility"("value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_venue_layout_capacities"("venue_capacity" integer, "value" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    AS $_$
declare
    layout jsonb;
begin
    if venue_capacity is null
        or jsonb_typeof(value) <> 'array'
    then
        return false;
    end if;

    for layout in
        select jsonb_array_elements(value)
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
$_$;


ALTER FUNCTION "public"."validate_venue_layout_capacities"("venue_capacity" integer, "value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_venue_layouts"("value" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    AS $_$
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
$_$;


ALTER FUNCTION "public"."validate_venue_layouts"("value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_venue_operating_hours"("value" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    AS $_$
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
$_$;


ALTER FUNCTION "public"."validate_venue_operating_hours"("value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."withdraw_event_registration"("p_registration_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    target_event_id uuid;
    current_event public.events%rowtype;
    current_registration public.event_registrations%rowtype;
    changed boolean := false;
    registration jsonb;
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'attendee'
    ) then
        raise exception 'Only a signed-in attendee can withdraw a registration';
    end if;

    -- Locate the owned row without locking the child before its parent.
    select event_id into target_event_id
    from public.event_registrations
    where id = p_registration_id and attendee_id = auth.uid();
    if not found then
        raise exception 'Registration was not found';
    end if;

    select * into current_event from public.events
    where id = target_event_id for update;
    if not found then
        raise exception 'Registration was not found';
    end if;

    select * into current_registration from public.event_registrations
    where id = p_registration_id and attendee_id = auth.uid() for update;
    if not found then
        raise exception 'Registration was not found';
    end if;

    -- Retries preserve the first withdrawal's timestamp and notification state.
    if current_registration.status <> 'withdrawn' then
        if current_event.status not in ('under_review', 'planning', 'awaiting_safety_check', 'confirmed') then
            raise exception 'Withdrawal is unavailable for an event that has ended or been cancelled';
        end if;
        -- A lock wait may cross the cutoff, so transaction start time is unsafe.
        if current_event.start_time is null or current_event.start_time <= clock_timestamp() then
            raise exception 'Withdrawal is unavailable once the event has started';
        end if;

        update public.event_registrations
        set status = 'withdrawn', withdrawn_at = clock_timestamp()
        where id = p_registration_id;
        changed := true;
    end if;

    select to_jsonb(r) into registration
    from public.list_my_registrations(p_registration_id) r;
    return jsonb_build_object('registration', registration, 'changed', changed);
end;
$$;


ALTER FUNCTION "public"."withdraw_event_registration"("p_registration_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "venue_private"."complete_venue_holds"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if new.status='APPROVED' then
        update public.venue_tentative_holds set released_at=clock_timestamp(), completed_booking_id=new.booking_id
        where event_id=new.event_id and venue_id=new.venue_id and released_at is null
            and start_at>=new.start_at and end_at<=new.end_at;
    end if;
    return new;
end; $$;


ALTER FUNCTION "venue_private"."complete_venue_holds"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "venue_private"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
    v public.venues%rowtype;
    e public.events%rowtype;
    h public.venue_tentative_holds%rowtype;
    occupied_start timestamptz;
    occupied_end timestamptz;
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can create holds.' using errcode = '42501';
    end if;
    -- Serialize hold creation on a venue. Existing approval/block workflows
    -- still need the team's shared locking contract to eliminate cross-flow races.
    select * into v from public.venues where id=p_venue_id for update;
    select * into e from public.events where id=p_event_id;
    if v.id is null or e.id is null or e.coordinator_id is null
        or e.status not in ('under_review', 'planning', 'change_requested', 'confirmed')
        or e.end_time<=now() or p_start_at>=p_end_at or p_expires_at<=now()
        or p_expires_at>p_start_at or p_start_at is null or p_end_at is null or p_expires_at is null
        or v.operating_hours->>'open' is null or v.operating_hours->>'close' is null
        or v.setup_time_minutes is null or v.turnaround_time_minutes is null then
        raise exception 'Invalid hold period, event, expiry or venue buffers.' using errcode = '22023';
    end if;
    occupied_start := p_start_at - make_interval(mins => v.setup_time_minutes);
    occupied_end := p_end_at + make_interval(mins => v.turnaround_time_minutes);
    if p_expires_at>occupied_start
        or (occupied_start at time zone 'Asia/Singapore')::date<>(occupied_end at time zone 'Asia/Singapore')::date
        or (occupied_start at time zone 'Asia/Singapore')::time<(v.operating_hours->>'open')::time
        or (occupied_end at time zone 'Asia/Singapore')::time>(v.operating_hours->>'close')::time then
        raise exception 'Expiry must precede setup; occupied time must fit operating hours.' using errcode='22023';
    end if;
    if exists (select 1 from public.venue_blocks b where b.venue_id=p_venue_id
        and b.start_at<occupied_end and occupied_start<b.end_at)
        or exists (select 1 from jsonb_array_elements(venue_private.get_venue_reservations(array[p_venue_id])) r
            where (r->>'start_at')::timestamptz<occupied_end and occupied_start<(r->>'end_at')::timestamptz) then
        raise exception 'Venue period already occupied.' using errcode = '23P01';
    end if;
    insert into public.venue_tentative_holds(venue_id,event_id,start_at,end_at,expires_at,created_by)
        values(p_venue_id,p_event_id,p_start_at,p_end_at,p_expires_at,auth.uid()) returning * into h;
    return to_jsonb(h)||jsonb_build_object('event_name',e.name,'venue_name',v.name,'coordinator_id',e.coordinator_id);
end; $$;


ALTER FUNCTION "venue_private"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "venue_private"."get_venue_block_bookings"("p_venue_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can check affected bookings.'
            using errcode = '42501';
    end if;

    -- One JSON value avoids PostgREST's row cap hiding affected bookings.
    -- event_id has no FK in the current booking schema: join it explicitly.
    -- A reassigned event must notify its CURRENT Coordinator, not its submitter.
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'booking_id', b.booking_id,
            'venue_id', b.venue_id,
            'venue_name', v.name,
            'event_id', b.event_id,
            'event_name', e.name,
            'coordinator_id', case when b.event_id is null
                then b.coordinator_id else e.coordinator_id end,
            'status', b.status,
            'start_at', b.start_at,
            'end_at', b.end_at,
            'setup_time_minutes', v.setup_time_minutes,
            'turnaround_time_minutes', v.turnaround_time_minutes
        ) order by b.booking_id), '[]'::jsonb)
        from public.venue_bookings b
        join public.venues v on v.id = b.venue_id
        left join public.events e on e.id = b.event_id
        where b.venue_id = p_venue_id and b.status = 'APPROVED'
    );
end;
$$;


ALTER FUNCTION "venue_private"."get_venue_block_bookings"("p_venue_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "venue_private"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) RETURNS TABLE("booking_id" "uuid", "event_name" "text", "session_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    SET "row_security" TO 'on'
    AS $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can read booking names.' using errcode = '42501';
    end if;

    -- Fail closed if ownership/grants drift or booking RLS is disabled.
    if not pg_catalog.row_security_active('public.venue_bookings'::pg_catalog.regclass) then
        raise exception 'Booking row security must be active.' using errcode = '42501';
    end if;

    return query
    select b.booking_id, n.event_name, n.session_name
    from public.venue_bookings b
    join venue_private.venue_booking_name_projection n on n.booking_id = b.booking_id
    where b.booking_id = any(p_booking_ids)
      and b.status = 'PENDING_VENUE_APPROVAL';
end;
$$;


ALTER FUNCTION "venue_private"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) OWNER TO "venue_booking_name_reader";


CREATE OR REPLACE FUNCTION "venue_private"."get_venue_hold_events"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not public.is_venue_staff() then
        raise exception 'Only Venue Staff can select hold events.' using errcode = '42501';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.start_time), '[]'::jsonb)
        from public.events e where e.coordinator_id is not null
        and e.status in ('under_review', 'planning', 'change_requested', 'confirmed') and e.end_time > now());
end; $$;


ALTER FUNCTION "venue_private"."get_venue_hold_events"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "venue_private"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid" DEFAULT NULL::"uuid", "p_holds_only" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    if auth.uid() is null or not exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role in ('venue_staff', 'coordinator')
    ) then
        raise exception 'Only venue staff and Coordinators can check reservations.' using errcode = '42501';
    end if;
    -- Coordinators may exclude only their own event; staff use this during approval.
    if p_exclude_event_id is not null and not public.is_venue_staff() and not exists (
        select 1 from public.events e where e.id = p_exclude_event_id and e.coordinator_id = auth.uid()
    ) then
        raise exception 'Event is not assigned to you.' using errcode = '42501';
    end if;
    if exists (select 1 from public.venue_tentative_holds h join public.venues v on v.id=h.venue_id
        where h.venue_id=any(p_venue_ids) and h.released_at is null and h.expires_at>now()
        and (v.setup_time_minutes is null or v.turnaround_time_minutes is null)) then
        raise exception 'Venue buffer configuration unavailable.' using errcode = '22023';
    end if;
    if not p_holds_only and exists (
        select 1 from public.venue_bookings b join public.venues v on v.id=b.venue_id
        where b.venue_id=any(p_venue_ids) and b.status in ('APPROVED','AFFECTED_BY_UNAVAILABILITY')
            and (v.setup_time_minutes is null or v.turnaround_time_minutes is null)
    ) then
        raise exception 'Venue buffer configuration unavailable.' using errcode = '22023';
    end if;
    return (select coalesce(jsonb_agg(to_jsonb(r) order by r.start_at, r.id), '[]'::jsonb) from (
        select b.booking_id as id, b.venue_id, 'confirmed_booking'::text as type,
            least(b.effective_start_at, b.start_at-make_interval(mins => greatest(v.setup_time_minutes,b.setup_buffer_minutes))) as start_at,
            greatest(b.effective_end_at, b.end_at+make_interval(mins => greatest(v.turnaround_time_minutes,b.teardown_buffer_minutes))) as end_at,
            case when b.status='AFFECTED_BY_UNAVAILABILITY' then 'Venue affected' else 'Confirmed booking' end as reason,
            null::timestamptz as expires_at,
            b.start_at as event_start_at, b.end_at as event_end_at,
            -- Display grouping is not proven provenance: retain the original details.
            coalesce((select jsonb_agg(jsonb_build_object('id',vb.block_id,'start_at',vb.start_at,
                'end_at',vb.end_at,'reason',vb.block_reason) order by vb.block_id)
                from public.venue_blocks vb
                where vb.source_booking_id is null and vb.venue_id=b.venue_id
                    and vb.start_at=b.effective_start_at and vb.end_at=b.effective_end_at
                    and vb.block_issuer=b.reviewed_by
                    and vb.block_reason='Approved Booking: '||e.name||' ('||b.room_layout||')'
                    and 1=(select count(*) from public.venue_bookings other
                        join public.events oe on oe.id=other.event_id
                        where other.venue_id=vb.venue_id and other.effective_start_at=vb.start_at
                            and other.effective_end_at=vb.end_at and other.reviewed_by=vb.block_issuer
                            and vb.block_reason='Approved Booking: '||oe.name||' ('||other.room_layout||')'
                            and other.status in ('APPROVED','AFFECTED_BY_UNAVAILABILITY'))), '[]'::jsonb) as legacy_blocks
        from public.venue_bookings b join public.venues v on v.id=b.venue_id
        left join public.events e on e.id=b.event_id
        where not p_holds_only and b.venue_id=any(p_venue_ids)
            and b.status in ('APPROVED', 'AFFECTED_BY_UNAVAILABILITY')
        union all
        select h.hold_id, h.venue_id, 'tentative_hold',
            h.start_at - make_interval(mins => v.setup_time_minutes),
            h.end_at + make_interval(mins => v.turnaround_time_minutes),
            'Tentative hold', h.expires_at, h.start_at, h.end_at, '[]'::jsonb
        from public.venue_tentative_holds h join public.venues v on v.id=h.venue_id
        where h.venue_id=any(p_venue_ids) and h.released_at is null and h.expires_at>now()
            and (p_exclude_event_id is null or h.event_id<>p_exclude_event_id)
    ) r);
end; $$;


ALTER FUNCTION "venue_private"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "maintenance_status" "text" DEFAULT 'Functional'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."equipment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment_bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "equipment_id" "uuid" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "line_id" "uuid",
    CONSTRAINT "equipment_bookings_time_order" CHECK (("end_at" > "start_at"))
);


ALTER TABLE "public"."equipment_bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment_request_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "equipment_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    CONSTRAINT "equipment_request_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."equipment_request_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment_request_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "item_name" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "specifics" "text",
    CONSTRAINT "equipment_request_lines_item_name_not_blank" CHECK ((("length"("btrim"("item_name")) >= 1) AND ("length"("btrim"("item_name")) <= 120))),
    CONSTRAINT "equipment_request_lines_quantity_positive" CHECK ((("quantity" >= 1) AND ("quantity" <= 100))),
    CONSTRAINT "equipment_request_lines_specifics_length" CHECK ((("specifics" IS NULL) OR ("length"("specifics") <= 500)))
);


ALTER TABLE "public"."equipment_request_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "coordinator_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'Pending Technical Approval'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_details" "text" NOT NULL,
    "session_id" "uuid",
    "cancellation_reason" "text",
    "cancelled_at" timestamp with time zone,
    "cancelled_by" "uuid",
    "rejection_reason" "text",
    CONSTRAINT "equipment_requests_status_valid" CHECK (("status" = ANY (ARRAY['Pending Technical Approval'::"text", 'Approved'::"text", 'Rejected'::"text", 'Cancelled'::"text"])))
);


ALTER TABLE "public"."equipment_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_activity_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "previous_coordinator_id" "uuid",
    "new_coordinator_id" "uuid" NOT NULL,
    "changed_by_id" "uuid" NOT NULL,
    "action_type" "text" DEFAULT 'REASSIGNMENT'::"text" NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_activity_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_cancellation_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "organiser_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decision_reason" "text",
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    CONSTRAINT "event_cancellation_requests_decision_reason_not_blank" CHECK ((("decision_reason" IS NULL) OR ("length"("btrim"("decision_reason")) > 0))),
    CONSTRAINT "event_cancellation_requests_reason_not_blank" CHECK (("length"("btrim"("reason")) > 0)),
    CONSTRAINT "event_cancellation_requests_status_valid" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."event_cancellation_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_change_request_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "change_request_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "name" "text" NOT NULL,
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "expected_attendance" integer NOT NULL,
    "location_preference" "text",
    "layout_preference" "text",
    "equipment_requirements" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_change_request_sessions_end_after_start" CHECK (("end_time" > "start_time")),
    CONSTRAINT "event_change_request_sessions_expected_attendance_check" CHECK (("expected_attendance" > 0)),
    CONSTRAINT "event_change_request_sessions_name_check" CHECK (("length"("btrim"("name")) > 0))
);


ALTER TABLE "public"."event_change_request_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_change_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "organiser_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "category" "text" NOT NULL,
    "category_other" "text",
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "expected_attendance" integer NOT NULL,
    "location_preference" "text",
    "layout_preference" "text",
    "accessibility_requirements" "text",
    "equipment_requirements" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "reason_for_change" "text" NOT NULL,
    "decision_reason" "text",
    "closed_by" "uuid",
    CONSTRAINT "event_change_requests_attendance_positive" CHECK (("expected_attendance" > 0)),
    CONSTRAINT "event_change_requests_category_other_matches_category" CHECK (((("category" = 'other'::"text") AND ("category_other" IS NOT NULL) AND ("length"("btrim"("category_other")) > 0)) OR (("category" <> 'other'::"text") AND ("category_other" IS NULL)))),
    CONSTRAINT "event_change_requests_category_valid" CHECK (("category" = ANY (ARRAY['conference'::"text", 'workshop'::"text", 'seminar'::"text", 'meeting'::"text", 'networking'::"text", 'product_launch'::"text", 'training'::"text", 'social_event'::"text", 'ceremony'::"text", 'other'::"text"]))),
    CONSTRAINT "event_change_requests_decision_reason_not_blank" CHECK ((("decision_reason" IS NULL) OR ("length"("btrim"("decision_reason")) > 0))),
    CONSTRAINT "event_change_requests_description_not_blank" CHECK (("length"("btrim"("description")) > 0)),
    CONSTRAINT "event_change_requests_end_after_start" CHECK (("end_time" > "start_time")),
    CONSTRAINT "event_change_requests_name_not_blank" CHECK (("length"("btrim"("name")) > 0)),
    CONSTRAINT "event_change_requests_purpose_not_blank" CHECK (("length"("btrim"("purpose")) > 0)),
    CONSTRAINT "event_change_requests_reason_not_blank" CHECK (("length"("btrim"("reason_for_change")) > 0)),
    CONSTRAINT "event_change_requests_status_valid" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."event_change_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_clarifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "organiser_id" "uuid" NOT NULL,
    "coordinator_id" "uuid" NOT NULL,
    "coordinator_notes" "text" NOT NULL,
    "organiser_response" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "closed_by" "uuid",
    CONSTRAINT "event_clarifications_coordinator_notes_check" CHECK ((("length"("btrim"("coordinator_notes")) >= 1) AND ("length"("btrim"("coordinator_notes")) <= 5000))),
    CONSTRAINT "event_clarifications_organiser_response_check" CHECK ((("organiser_response" IS NULL) OR (("length"("btrim"("organiser_response")) >= 1) AND ("length"("btrim"("organiser_response")) <= 5000)))),
    CONSTRAINT "event_clarifications_status_valid" CHECK (("status" = ANY (ARRAY['pending'::"text", 'answered'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."event_clarifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_registrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "attendee_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "address" "text",
    "contact_number" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'registered'::"text" NOT NULL,
    "withdrawn_at" timestamp with time zone,
    CONSTRAINT "event_registrations_address_check" CHECK (("length"("btrim"("address")) > 0)),
    CONSTRAINT "event_registrations_contact_number_check" CHECK (("length"("btrim"("contact_number")) > 0)),
    CONSTRAINT "event_registrations_email_check" CHECK (("length"("btrim"("email")) > 0)),
    CONSTRAINT "event_registrations_full_name_check" CHECK (("length"("btrim"("full_name")) > 0)),
    CONSTRAINT "event_registrations_status_valid" CHECK (("status" = ANY (ARRAY['registered'::"text", 'withdrawn'::"text"]))),
    CONSTRAINT "event_registrations_withdrawal_time_valid" CHECK ((("status" = 'withdrawn'::"text") = ("withdrawn_at" IS NOT NULL)))
);


ALTER TABLE "public"."event_registrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_safety_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "safety_officer_id" "uuid" NOT NULL,
    "decision" "text" NOT NULL,
    "notes" "text",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_safety_reviews_decision_check" CHECK (("decision" = ANY (ARRAY['APPROVED'::"text", 'REJECTED'::"text", 'CHANGES_REQUESTED'::"text"]))),
    CONSTRAINT "safety_reviews_reason_required_for_non_approval" CHECK ((("decision" = 'APPROVED'::"text") OR (("reason" IS NOT NULL) AND ("length"("btrim"("reason")) > 0))))
);


ALTER TABLE "public"."event_safety_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "is_read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notifications_title_not_blank" CHECK (("length"("btrim"("title")) > 0)),
    CONSTRAINT "notifications_type_not_blank" CHECK (("length"("btrim"("type")) > 0))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_number" "text",
    "organization" "text",
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['organiser'::"text", 'attendee'::"text", 'coordinator'::"text", 'venue_staff'::"text", 'tech_support'::"text", 'event_coordinator_lead'::"text", 'safety_officer'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_change_request_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "safety_change_request_messages_message_check" CHECK (("length"("btrim"("message")) > 0))
);


ALTER TABLE "public"."safety_change_request_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_blocks" (
    "block_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "block_reason" "text" NOT NULL,
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "block_issuer" "uuid" NOT NULL,
    "booking_id" "uuid",
    "source_booking_id" "uuid",
    CONSTRAINT "venue_blocks_reason_not_blank" CHECK (("length"("btrim"("block_reason")) > 0)),
    CONSTRAINT "venue_blocks_valid_period" CHECK (("end_at" > "start_at"))
);


ALTER TABLE "public"."venue_blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_bookings" (
    "booking_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "coordinator_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "room_layout" character varying(100) NOT NULL,
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "setup_buffer_minutes" integer DEFAULT 0 NOT NULL,
    "teardown_buffer_minutes" integer DEFAULT 0 NOT NULL,
    "effective_start_at" timestamp with time zone NOT NULL,
    "effective_end_at" timestamp with time zone NOT NULL,
    "status" character varying(50) DEFAULT 'PENDING_VENUE_APPROVAL'::character varying NOT NULL,
    "rejection_reason" "text",
    "reviewed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "session_id" "uuid",
    "cancellation_reason" "text",
    "cancelled_at" timestamp with time zone,
    "cancelled_by" "uuid"
);


ALTER TABLE "public"."venue_bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_edit_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "changed_by" "uuid" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "changed_fields" "text"[] NOT NULL,
    "old_values" "jsonb" NOT NULL,
    "new_values" "jsonb" NOT NULL,
    CONSTRAINT "venue_edit_history_fields_not_empty" CHECK (("cardinality"("changed_fields") > 0)),
    CONSTRAINT "venue_edit_history_values_are_objects" CHECK ((("jsonb_typeof"("old_values") = 'object'::"text") AND ("jsonb_typeof"("new_values") = 'object'::"text")))
);


ALTER TABLE "public"."venue_edit_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_tentative_holds" (
    "hold_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "released_at" timestamp with time zone,
    "completed_booking_id" "uuid",
    "expiry_claimed_at" timestamp with time zone,
    "expiry_notified_at" timestamp with time zone,
    CONSTRAINT "venue_hold_expiry" CHECK ((("created_at" < "expires_at") AND ("expires_at" <= "start_at"))),
    CONSTRAINT "venue_hold_period" CHECK (("start_at" < "end_at"))
);


ALTER TABLE "public"."venue_tentative_holds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "location" "text",
    "capacity" integer NOT NULL,
    "facilities" "jsonb",
    "accessibility" "jsonb",
    "layouts" "jsonb" NOT NULL,
    "operating_hours" "jsonb" NOT NULL,
    "setup_time_minutes" integer DEFAULT 0 NOT NULL,
    "turnaround_time_minutes" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "venues_accessibility_valid" CHECK ("public"."validate_venue_accessibility"("accessibility")),
    CONSTRAINT "venues_capacity_positive" CHECK (("capacity" > 0)),
    CONSTRAINT "venues_layout_capacities_within_venue" CHECK ("public"."validate_venue_layout_capacities"("capacity", "layouts")),
    CONSTRAINT "venues_layouts_valid" CHECK ("public"."validate_venue_layouts"("layouts")),
    CONSTRAINT "venues_name_not_blank" CHECK (("length"("btrim"("name")) > 0)),
    CONSTRAINT "venues_operating_hours_valid" CHECK ("public"."validate_venue_operating_hours"("operating_hours")),
    CONSTRAINT "venues_setup_time_nonnegative" CHECK (("setup_time_minutes" >= 0)),
    CONSTRAINT "venues_turnaround_time_nonnegative" CHECK (("turnaround_time_minutes" >= 0))
);


ALTER TABLE "public"."venues" OWNER TO "postgres";


CREATE OR REPLACE VIEW "venue_private"."venue_booking_name_projection" WITH ("security_barrier"='true') AS
 SELECT "b"."booking_id",
    "e"."name" AS "event_name",
    "s"."name" AS "session_name"
   FROM (("public"."venue_bookings" "b"
     JOIN "public"."events" "e" ON (("e"."id" = "b"."event_id")))
     LEFT JOIN "public"."event_sessions" "s" ON ((("s"."id" = "b"."session_id") AND ("s"."event_id" = "b"."event_id"))))
  WHERE (("b"."status")::"text" = 'PENDING_VENUE_APPROVAL'::"text");


ALTER VIEW "venue_private"."venue_booking_name_projection" OWNER TO "postgres";


ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_no_overlap" EXCLUDE USING "gist" ("equipment_id" WITH =, "tstzrange"("start_at", "end_at", '[)'::"text") WITH &&);



ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."equipment"
    ADD CONSTRAINT "equipment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."equipment_request_items"
    ADD CONSTRAINT "equipment_request_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."equipment_request_items"
    ADD CONSTRAINT "equipment_request_items_unique_equipment" UNIQUE ("request_id", "equipment_id");



ALTER TABLE ONLY "public"."equipment_request_lines"
    ADD CONSTRAINT "equipment_request_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."equipment_requests"
    ADD CONSTRAINT "equipment_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_activity_logs"
    ADD CONSTRAINT "event_activity_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_cancellation_requests"
    ADD CONSTRAINT "event_cancellation_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_change_request_sessions"
    ADD CONSTRAINT "event_change_request_sessions_one_per_session" UNIQUE ("change_request_id", "session_id");



ALTER TABLE ONLY "public"."event_change_request_sessions"
    ADD CONSTRAINT "event_change_request_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_change_requests"
    ADD CONSTRAINT "event_change_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_clarifications"
    ADD CONSTRAINT "event_clarifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_registrations"
    ADD CONSTRAINT "event_registrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_safety_reviews"
    ADD CONSTRAINT "event_safety_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_sessions"
    ADD CONSTRAINT "event_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."safety_change_request_messages"
    ADD CONSTRAINT "safety_change_request_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."venue_blocks"
    ADD CONSTRAINT "venue_blocks_pkey" PRIMARY KEY ("block_id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_pkey" PRIMARY KEY ("booking_id");



ALTER TABLE ONLY "public"."venue_edit_history"
    ADD CONSTRAINT "venue_edit_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."venue_tentative_holds"
    ADD CONSTRAINT "venue_tentative_holds_pkey" PRIMARY KEY ("hold_id");



ALTER TABLE ONLY "public"."venues"
    ADD CONSTRAINT "venues_pkey" PRIMARY KEY ("id");



CREATE INDEX "equipment_bookings_request_id_idx" ON "public"."equipment_bookings" USING "btree" ("request_id");



CREATE UNIQUE INDEX "equipment_request_lines_one_per_item" ON "public"."equipment_request_lines" USING "btree" ("request_id", "lower"("item_name"));



CREATE INDEX "equipment_requests_coordinator_id_idx" ON "public"."equipment_requests" USING "btree" ("coordinator_id");



CREATE INDEX "equipment_requests_event_id_idx" ON "public"."equipment_requests" USING "btree" ("event_id");



CREATE UNIQUE INDEX "equipment_requests_session_id_key" ON "public"."equipment_requests" USING "btree" ("session_id") WHERE (("session_id" IS NOT NULL) AND ("status" <> 'Cancelled'::"text"));



CREATE UNIQUE INDEX "event_cancellation_requests_one_pending_per_event" ON "public"."event_cancellation_requests" USING "btree" ("event_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "event_cancellation_requests_organiser_idx" ON "public"."event_cancellation_requests" USING "btree" ("organiser_id", "created_at" DESC);



CREATE INDEX "event_change_request_sessions_change_request_idx" ON "public"."event_change_request_sessions" USING "btree" ("change_request_id");



CREATE UNIQUE INDEX "event_change_requests_one_pending_per_event" ON "public"."event_change_requests" USING "btree" ("event_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "event_change_requests_organiser_idx" ON "public"."event_change_requests" USING "btree" ("organiser_id", "created_at" DESC);



CREATE INDEX "event_clarifications_event_requested_idx" ON "public"."event_clarifications" USING "btree" ("event_id", "created_at");



CREATE UNIQUE INDEX "event_clarifications_one_pending_per_event" ON "public"."event_clarifications" USING "btree" ("event_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "event_registrations_one_active_per_attendee" ON "public"."event_registrations" USING "btree" ("event_id", "attendee_id") WHERE ("status" = 'registered'::"text");



CREATE INDEX "event_safety_reviews_event_id_idx" ON "public"."event_safety_reviews" USING "btree" ("event_id", "created_at" DESC);



CREATE INDEX "event_sessions_event_id_idx" ON "public"."event_sessions" USING "btree" ("event_id");



CREATE INDEX "events_coordinator_status_start_idx" ON "public"."events" USING "btree" ("coordinator_id", "status", "start_time");



CREATE INDEX "events_organiser_id_idx" ON "public"."events" USING "btree" ("organiser_id");



CREATE INDEX "notifications_user_id_created_at_idx" ON "public"."notifications" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "safety_change_messages_event_idx" ON "public"."safety_change_request_messages" USING "btree" ("event_id", "created_at");



CREATE INDEX "venue_blocks_booking" ON "public"."venue_blocks" USING "btree" ("source_booking_id");



CREATE INDEX "venue_blocks_booking_id_idx" ON "public"."venue_blocks" USING "btree" ("booking_id");



CREATE INDEX "venue_blocks_booking_source_idx" ON "public"."venue_blocks" USING "btree" ("source_booking_id");



CREATE INDEX "venue_bookings_session_id_idx" ON "public"."venue_bookings" USING "btree" ("session_id");



CREATE INDEX "venue_edit_history_venue_changed_at_idx" ON "public"."venue_edit_history" USING "btree" ("venue_id", "changed_at" DESC);



CREATE INDEX "venue_holds_due" ON "public"."venue_tentative_holds" USING "btree" ("expires_at") WHERE ("expiry_notified_at" IS NULL);



CREATE INDEX "venue_holds_live" ON "public"."venue_tentative_holds" USING "btree" ("venue_id", "expires_at") WHERE ("released_at" IS NULL);



CREATE UNIQUE INDEX "venues_name_unique_case_insensitive" ON "public"."venues" USING "btree" ("lower"("btrim"("name")));



CREATE OR REPLACE TRIGGER "complete_venue_holds" AFTER INSERT OR UPDATE OF "status" ON "public"."venue_bookings" FOR EACH ROW EXECUTE FUNCTION "venue_private"."complete_venue_holds"();



CREATE OR REPLACE TRIGGER "equipment_default_type" BEFORE INSERT OR UPDATE ON "public"."equipment" FOR EACH ROW EXECUTE FUNCTION "public"."default_equipment_type"();



CREATE OR REPLACE TRIGGER "event_cancellation_requests_reject_completed" BEFORE INSERT ON "public"."event_cancellation_requests" FOR EACH ROW EXECUTE FUNCTION "public"."reject_completed_event_request"();



CREATE OR REPLACE TRIGGER "event_change_requests_reject_completed" BEFORE INSERT ON "public"."event_change_requests" FOR EACH ROW EXECUTE FUNCTION "public"."reject_completed_event_request"();



CREATE OR REPLACE TRIGGER "event_clarifications_reject_completed" BEFORE INSERT ON "public"."event_clarifications" FOR EACH ROW EXECUTE FUNCTION "public"."reject_completed_event_request"();



CREATE OR REPLACE TRIGGER "event_sessions_sync_event" AFTER INSERT OR DELETE OR UPDATE ON "public"."event_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."sync_event_from_sessions"();



CREATE OR REPLACE TRIGGER "events_block_forward_move_while_open" BEFORE UPDATE OF "status" ON "public"."events" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."block_forward_move_while_open"();



CREATE OR REPLACE TRIGGER "events_expire_open_requests" AFTER UPDATE OF "status" ON "public"."events" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") AND ("new"."status" = ANY (ARRAY['completed'::"text", 'rejected'::"text", 'cancelled'::"text"])))) EXECUTE FUNCTION "public"."expire_open_requests_when_event_ends"();



CREATE OR REPLACE TRIGGER "events_track_safety_check_request" BEFORE UPDATE OF "status" ON "public"."events" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."track_safety_check_request"();



CREATE OR REPLACE TRIGGER "venues_record_edit" AFTER UPDATE ON "public"."venues" FOR EACH ROW EXECUTE FUNCTION "public"."record_venue_edit"();



ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."equipment_request_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."equipment_bookings"
    ADD CONSTRAINT "equipment_bookings_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."equipment_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."equipment_request_items"
    ADD CONSTRAINT "equipment_request_items_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id");



ALTER TABLE ONLY "public"."equipment_request_items"
    ADD CONSTRAINT "equipment_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."equipment_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."equipment_request_lines"
    ADD CONSTRAINT "equipment_request_lines_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."equipment_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."equipment_requests"
    ADD CONSTRAINT "equipment_requests_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."equipment_requests"
    ADD CONSTRAINT "equipment_requests_coordinator_id_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."equipment_requests"
    ADD CONSTRAINT "equipment_requests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."equipment_requests"
    ADD CONSTRAINT "equipment_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."event_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_activity_logs"
    ADD CONSTRAINT "event_activity_logs_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_activity_logs"
    ADD CONSTRAINT "event_activity_logs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_activity_logs"
    ADD CONSTRAINT "event_activity_logs_new_coordinator_id_fkey" FOREIGN KEY ("new_coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_activity_logs"
    ADD CONSTRAINT "event_activity_logs_previous_coordinator_id_fkey" FOREIGN KEY ("previous_coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_cancellation_requests"
    ADD CONSTRAINT "event_cancellation_requests_decision_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_cancellation_requests"
    ADD CONSTRAINT "event_cancellation_requests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_cancellation_requests"
    ADD CONSTRAINT "event_cancellation_requests_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_change_request_sessions"
    ADD CONSTRAINT "event_change_request_sessions_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "public"."event_change_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_change_request_sessions"
    ADD CONSTRAINT "event_change_request_sessions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."event_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_change_requests"
    ADD CONSTRAINT "event_change_requests_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_change_requests"
    ADD CONSTRAINT "event_change_requests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_change_requests"
    ADD CONSTRAINT "event_change_requests_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_clarifications"
    ADD CONSTRAINT "event_clarifications_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_clarifications"
    ADD CONSTRAINT "event_clarifications_coordinator_id_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_clarifications"
    ADD CONSTRAINT "event_clarifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_clarifications"
    ADD CONSTRAINT "event_clarifications_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_registrations"
    ADD CONSTRAINT "event_registrations_attendee_id_fkey" FOREIGN KEY ("attendee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_registrations"
    ADD CONSTRAINT "event_registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_safety_reviews"
    ADD CONSTRAINT "event_safety_reviews_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_safety_reviews"
    ADD CONSTRAINT "event_safety_reviews_safety_officer_id_fkey" FOREIGN KEY ("safety_officer_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."event_sessions"
    ADD CONSTRAINT "event_sessions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_coordinator_id_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_safety_reviewed_by_fkey" FOREIGN KEY ("safety_reviewed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "fk_venue_bookings_event" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_change_request_messages"
    ADD CONSTRAINT "safety_change_request_messages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_change_request_messages"
    ADD CONSTRAINT "safety_change_request_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_blocks"
    ADD CONSTRAINT "venue_blocks_block_issuer_fkey" FOREIGN KEY ("block_issuer") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_blocks"
    ADD CONSTRAINT "venue_blocks_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."venue_bookings"("booking_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."venue_blocks"
    ADD CONSTRAINT "venue_blocks_source_booking_id_fkey" FOREIGN KEY ("source_booking_id") REFERENCES "public"."venue_bookings"("booking_id");



ALTER TABLE ONLY "public"."venue_blocks"
    ADD CONSTRAINT "venue_blocks_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_coordinator_id_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."event_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."venue_bookings"
    ADD CONSTRAINT "venue_bookings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."venue_edit_history"
    ADD CONSTRAINT "venue_edit_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_edit_history"
    ADD CONSTRAINT "venue_edit_history_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id");



ALTER TABLE ONLY "public"."venue_tentative_holds"
    ADD CONSTRAINT "venue_tentative_holds_completed_booking_id_fkey" FOREIGN KEY ("completed_booking_id") REFERENCES "public"."venue_bookings"("booking_id");



ALTER TABLE ONLY "public"."venue_tentative_holds"
    ADD CONSTRAINT "venue_tentative_holds_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."venue_tentative_holds"
    ADD CONSTRAINT "venue_tentative_holds_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."venue_tentative_holds"
    ADD CONSTRAINT "venue_tentative_holds_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id");



CREATE POLICY "Allow authenticated read equipment" ON "public"."equipment" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Allow authenticated users to read profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Allow insert activity logs" ON "public"."event_activity_logs" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Allow tech support insert equipment" ON "public"."equipment" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'tech_support'::"text")))));



CREATE POLICY "Allow tech support update equipment" ON "public"."equipment" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'tech_support'::"text")))));



CREATE POLICY "Allow view activity logs" ON "public"."event_activity_logs" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Attendees can view their own registrations" ON "public"."event_registrations" FOR SELECT TO "authenticated" USING (("attendee_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Authenticated users can view venue blocks" ON "public"."venue_blocks" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can view venues" ON "public"."venues" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Coordinators and Tech Support can view equipment requests" ON "public"."equipment_requests" FOR SELECT TO "authenticated" USING (("public"."is_tech_support"() OR ("public"."is_coordinator"() AND (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "equipment_requests"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid"))))))));



CREATE POLICY "Coordinators and Tech Support can view request lines" ON "public"."equipment_request_lines" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."equipment_requests" "equipment_request"
  WHERE (("equipment_request"."id" = "equipment_request_lines"."request_id") AND ("public"."is_tech_support"() OR ("public"."is_coordinator"() AND (EXISTS ( SELECT 1
           FROM "public"."events" "event"
          WHERE (("event"."id" = "equipment_request"."event_id") AND ("event"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")))))))))));



CREATE POLICY "Coordinators and Tech Support can view requested items" ON "public"."equipment_request_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."equipment_requests"
  WHERE (("equipment_requests"."id" = "equipment_request_items"."request_id") AND ("public"."is_tech_support"() OR ("public"."is_coordinator"() AND (EXISTS ( SELECT 1
           FROM "public"."events"
          WHERE (("events"."id" = "equipment_requests"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")))))))))));



CREATE POLICY "Coordinators can decide their assigned events under review" ON "public"."events" FOR UPDATE TO "authenticated" USING (("public"."is_coordinator"() AND ("coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = 'under_review'::"text"))) WITH CHECK (("public"."is_coordinator"() AND ("coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = ANY (ARRAY['planning'::"text", 'rejected'::"text"]))));



CREATE POLICY "Coordinators can decide their assigned reviewable events" ON "public"."events" FOR UPDATE TO "authenticated" USING (("public"."is_coordinator"() AND ("coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = ANY (ARRAY['under_review'::"text", 'planning'::"text"])))) WITH CHECK (("public"."is_coordinator"() AND ("coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = ANY (ARRAY['planning'::"text", 'rejected'::"text"]))));



CREATE POLICY "Coordinators can view assigned event cancellation requests" ON "public"."event_cancellation_requests" FOR SELECT TO "authenticated" USING (("public"."is_coordinator"() AND (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "event_cancellation_requests"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "Coordinators can view assigned event change requests" ON "public"."event_change_requests" FOR SELECT TO "authenticated" USING (("public"."is_coordinator"() AND (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "event_change_requests"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "Coordinators can view bookings for assigned events" ON "public"."equipment_bookings" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."equipment_requests" "equipment_request"
     JOIN "public"."events" "event" ON (("event"."id" = "equipment_request"."event_id")))
  WHERE (("equipment_request"."id" = "equipment_bookings"."request_id") AND "public"."is_coordinator"() AND ("event"."coordinator_id" = "auth"."uid"())))));



CREATE POLICY "Coordinators can view their assigned events" ON "public"."events" FOR SELECT TO "authenticated" USING (("public"."is_coordinator"() AND ("coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" <> 'draft'::"text")));



CREATE POLICY "Coordinators can view their events' organisers" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."organiser_id" = "profiles"."id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("events"."status" <> 'draft'::"text")))));



CREATE POLICY "Event participants can view clarification history" ON "public"."event_clarifications" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_clarifications"."event_id") AND (("public"."is_organiser"() AND ("e"."organiser_id" = ( SELECT "auth"."uid"() AS "uid"))) OR ("public"."is_coordinator"() AND ("e"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid"))))))));



CREATE POLICY "Organisers can add sessions to their own drafts" ON "public"."event_sessions" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_sessions"."event_id") AND ("e"."organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("e"."status" = 'draft'::"text")))));



CREATE POLICY "Organisers can delete their own drafts" ON "public"."events" FOR DELETE TO "authenticated" USING ((("organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = 'draft'::"text")));



CREATE POLICY "Organisers can edit sessions of their own drafts" ON "public"."event_sessions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_sessions"."event_id") AND ("e"."organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("e"."status" = 'draft'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_sessions"."event_id") AND ("e"."organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("e"."status" = 'draft'::"text")))));



CREATE POLICY "Organisers can edit their own drafts" ON "public"."events" FOR UPDATE TO "authenticated" USING ((("organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = 'draft'::"text"))) WITH CHECK ((("organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = ANY (ARRAY['draft'::"text", 'under_review'::"text"]))));



CREATE POLICY "Organisers can remove sessions from their own drafts" ON "public"."event_sessions" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_sessions"."event_id") AND ("e"."organiser_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("e"."status" = 'draft'::"text")))));



CREATE POLICY "Organisers can submit their own event requests" ON "public"."events" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_organiser"() AND ("organiser_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Organisers can view their events' coordinators" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."coordinator_id" = "profiles"."id") AND ("events"."organiser_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Organisers can view their own event cancellation requests" ON "public"."event_cancellation_requests" FOR SELECT TO "authenticated" USING (("organiser_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Organisers can view their own event change requests" ON "public"."event_change_requests" FOR SELECT TO "authenticated" USING (("organiser_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Organisers can view their own events" ON "public"."events" FOR SELECT TO "authenticated" USING (("organiser_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Safety Officers and Coordinators can view safety reviews" ON "public"."event_safety_reviews" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "event_safety_reviews"."event_id") AND (("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("events"."organiser_id" = ( SELECT "auth"."uid"() AS "uid"))))))));



CREATE POLICY "Safety Officers and assigned Coordinators can access messages" ON "public"."safety_change_request_messages" TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "safety_change_request_messages"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid"))))))) WITH CHECK ((("sender_id" = ( SELECT "auth"."uid"() AS "uid")) AND ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "safety_change_request_messages"."event_id") AND ("events"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid"))))))));



CREATE POLICY "Safety Officers can insert safety reviews" ON "public"."event_safety_reviews" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))) AND ("safety_officer_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Safety Officers can view equipment bookings" ON "public"."equipment_bookings" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))));



CREATE POLICY "Safety Officers can view equipment requests" ON "public"."equipment_requests" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'safety_officer'::"text")))));



CREATE POLICY "Tech Support can view events with equipment requests" ON "public"."events" FOR SELECT TO "authenticated" USING ("public"."tech_support_has_equipment_request"("id"));



CREATE POLICY "Technical Support can view equipment bookings" ON "public"."equipment_bookings" FOR SELECT TO "authenticated" USING ("public"."is_tech_support"());



CREATE POLICY "Users can mark their own notifications read" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Users can view sessions of change requests they can view" ON "public"."event_change_request_sessions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."event_change_requests" "change_request"
  WHERE ("change_request"."id" = "event_change_request_sessions"."change_request_id"))));



CREATE POLICY "Users can view sessions of events they can view" ON "public"."event_sessions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE ("e"."id" = "event_sessions"."event_id"))));



CREATE POLICY "Users can view their own notifications" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Venue Staff can update venues" ON "public"."venues" FOR UPDATE TO "authenticated" USING ("public"."is_venue_staff"()) WITH CHECK ("public"."is_venue_staff"());



CREATE POLICY "Venue staff can create venue blocks" ON "public"."venue_blocks" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_venue_staff"() AND ("block_issuer" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Venue staff can create venues" ON "public"."venues" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_venue_staff"());



CREATE POLICY "Venue staff can view venue edit history" ON "public"."venue_edit_history" FOR SELECT TO "authenticated" USING ("public"."is_venue_staff"());



CREATE POLICY "coordinator_insert_own_bookings" ON "public"."venue_bookings" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "coordinator_id"));



CREATE POLICY "coordinator_select_own_bookings" ON "public"."venue_bookings" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "coordinator_id"));



ALTER TABLE "public"."equipment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."equipment_bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."equipment_request_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."equipment_request_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."equipment_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_activity_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_cancellation_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_change_request_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_change_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_clarifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_registrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_safety_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert_own" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."safety_change_request_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff_manage_all_bookings" ON "public"."venue_bookings" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'venue_staff'::"text")))));



ALTER TABLE "public"."venue_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_edit_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_hold_read" ON "public"."venue_tentative_holds" FOR SELECT TO "authenticated" USING (("public"."is_venue_staff"() OR (EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "venue_tentative_holds"."event_id") AND ("e"."coordinator_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."venue_tentative_holds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venues" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT USAGE ON SCHEMA "venue_private" TO "authenticated";































































































































































































































































































































































































































































































































































































































































































































































REVOKE ALL ON FUNCTION "public"."acknowledge_venue_hold_expiry"("p_hold_id" "uuid", "p_claim" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acknowledge_venue_hold_expiry"("p_hold_id" "uuid", "p_claim" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_session_change_request"("p_event_id" "uuid", "p_cancel_booking_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_session_change_request"("p_event_id" "uuid", "p_cancel_booking_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_session_change_request"("p_event_id" "uuid", "p_cancel_booking_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."block_forward_move_while_open"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."block_forward_move_while_open"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_equipment_request"("p_request_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_equipment_request"("p_request_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_equipment_request"("p_request_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_venue_booking"("p_booking_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_venue_booking"("p_booking_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_venue_booking"("p_booking_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_expired_venue_holds"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_expired_venue_holds"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_ended_events"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_ended_events"() TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."events" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("description") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("purpose") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("category") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("start_time") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("end_time") ON TABLE "public"."events" TO "authenticated";
GRANT SELECT("end_time") ON TABLE "public"."events" TO "service_role";



GRANT UPDATE("expected_attendance") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("location_preference") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("layout_preference") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("accessibility_requirements") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("equipment_requirements") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("status") ON TABLE "public"."events" TO "authenticated";
GRANT SELECT("status"),UPDATE("status") ON TABLE "public"."events" TO "service_role";



GRANT UPDATE("category_other") ON TABLE "public"."events" TO "authenticated";



GRANT UPDATE("updated_at") ON TABLE "public"."events" TO "authenticated";
GRANT UPDATE("updated_at") ON TABLE "public"."events" TO "service_role";



GRANT SELECT("completed_at"),UPDATE("completed_at") ON TABLE "public"."events" TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_event_planning"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."count_event_registrations"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_equipment_booking"("p_equipment_id" "uuid", "p_request_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_line_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_equipment_booking"("p_equipment_id" "uuid", "p_request_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_line_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_equipment_booking"("p_equipment_id" "uuid", "p_request_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_line_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."default_equipment_type"() TO "anon";
GRANT ALL ON FUNCTION "public"."default_equipment_type"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."default_equipment_type"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_equipment_booking"("p_booking_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."equipment_request_time_windows"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."equipment_request_window"("p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."equipment_request_window"("p_request_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."equipment_request_window"("p_request_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."event_has_open_requests"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."event_has_open_requests"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."event_has_open_requests"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."event_planning_blockers"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_open_requests_when_event_ends"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_open_requests_when_event_ends"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_event_planning_readiness"("p_event_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tech_support_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_tech_support_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tech_support_users"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_venue_block_bookings"("p_venue_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_venue_block_bookings"("p_venue_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_venue_block_bookings"("p_venue_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_venue_hold_events"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_venue_hold_events"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_venue_hold_events"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_venue_operational_blocks"("p_venue_ids" "uuid"[], "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_venue_operational_blocks"("p_venue_ids" "uuid"[], "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_venue_operational_blocks"("p_venue_ids" "uuid"[], "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_coordinator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_coordinator"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_coordinator"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_coordinator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_organiser"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_organiser"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_organiser"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_organiser"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_tech_support"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_tech_support"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_tech_support"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_tech_support"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_venue_staff"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_venue_staff"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_venue_staff"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_venue_staff"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_all_equipment_bookings"("p_from" timestamp with time zone, "p_to" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_all_equipment_bookings"("p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_all_equipment_bookings"("p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_equipment_bookings"("p_equipment_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_equipment_bookings"("p_equipment_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_equipment_bookings"("p_equipment_id" "uuid", "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_equipment_request_review_queue"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_equipment_request_review_queue"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_equipment_request_review_queue"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_equipment_request_review_queue"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_event_arrangements"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_my_registrations"("p_registration_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_published_events"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_published_events"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."list_published_events"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_published_events"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_venue_block_bookings_affected"("p_venue_id" "uuid", "p_booking_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_venue_block_bookings_affected"("p_venue_id" "uuid", "p_booking_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_venue_block_bookings_affected"("p_venue_id" "uuid", "p_booking_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_venue_edit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_venue_edit"() TO "anon";
GRANT ALL ON FUNCTION "public"."record_venue_edit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_venue_edit"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_for_event"("p_event_id" "uuid", "p_full_name" "text", "p_contact_number" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_completed_event_request"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_completed_event_request"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_event_change_request"("p_event_id" "uuid", "p_rejection_reason" "text") TO "service_role";



GRANT ALL ON TABLE "public"."event_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."event_sessions" TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_draft_sessions"("p_event_id" "uuid", "p_sessions" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_draft_sessions"("p_event_id" "uuid", "p_sessions" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_draft_sessions"("p_event_id" "uuid", "p_sessions" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_event_clarification"("p_event_id" "uuid", "p_coordinator_id" "uuid", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."respond_to_event_clarification"("p_event_id" "uuid", "p_organiser_id" "uuid", "p_response" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."review_equipment_request"("p_request_id" "uuid", "p_decision" "text", "p_rejection_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."review_equipment_request"("p_request_id" "uuid", "p_decision" "text", "p_rejection_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."review_equipment_request"("p_request_id" "uuid", "p_decision" "text", "p_rejection_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."review_event_cancellation_request"("p_event_id" "uuid", "p_decision" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_event_registration"("p_event_id" "uuid", "p_opens_at" timestamp with time zone, "p_closes_at" timestamp with time zone, "p_capacity" integer, "p_publish" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_items" "jsonb", "p_request_details" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_session_id" "uuid", "p_items" "jsonb", "p_request_details" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_session_id" "uuid", "p_items" "jsonb", "p_request_details" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_equipment_request"("p_event_id" "uuid", "p_session_id" "uuid", "p_items" "jsonb", "p_request_details" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_equipment_request_lines"("p_event_id" "uuid", "p_session_id" "uuid", "p_lines" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_equipment_request_lines"("p_event_id" "uuid", "p_session_id" "uuid", "p_lines" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_equipment_request_lines"("p_event_id" "uuid", "p_session_id" "uuid", "p_lines" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_event_cancellation_request"("p_event_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_session_change_request"("p_event_id" "uuid", "p_changes" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_session_change_request"("p_event_id" "uuid", "p_changes" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_session_change_request"("p_event_id" "uuid", "p_changes" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_event_from_sessions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_event_from_sessions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tech_support_has_equipment_request"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."track_safety_check_request"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."track_safety_check_request"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_venue_accessibility"("value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_venue_accessibility"("value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_venue_accessibility"("value" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_venue_layout_capacities"("venue_capacity" integer, "value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_venue_layout_capacities"("venue_capacity" integer, "value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_venue_layout_capacities"("venue_capacity" integer, "value" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_venue_layouts"("value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_venue_layouts"("value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_venue_layouts"("value" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_venue_operating_hours"("value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_venue_operating_hours"("value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_venue_operating_hours"("value" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."withdraw_event_registration"("p_registration_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."withdraw_event_registration"("p_registration_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."withdraw_event_registration"("p_registration_id" "uuid") TO "service_role";












REVOKE ALL ON FUNCTION "venue_private"."complete_venue_holds"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "venue_private"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "venue_private"."create_venue_tentative_hold"("p_venue_id" "uuid", "p_event_id" "uuid", "p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "authenticated";



REVOKE ALL ON FUNCTION "venue_private"."get_venue_block_bookings"("p_venue_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "venue_private"."get_venue_block_bookings"("p_venue_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "venue_private"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "venue_private"."get_venue_booking_event_names"("p_booking_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "venue_private"."get_venue_hold_events"() FROM PUBLIC;
GRANT ALL ON FUNCTION "venue_private"."get_venue_hold_events"() TO "authenticated";



REVOKE ALL ON FUNCTION "venue_private"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "venue_private"."get_venue_reservations"("p_venue_ids" "uuid"[], "p_exclude_event_id" "uuid", "p_holds_only" boolean) TO "authenticated";















GRANT ALL ON TABLE "public"."equipment" TO "anon";
GRANT ALL ON TABLE "public"."equipment" TO "authenticated";
GRANT ALL ON TABLE "public"."equipment" TO "service_role";



GRANT ALL ON TABLE "public"."equipment_bookings" TO "service_role";
GRANT SELECT ON TABLE "public"."equipment_bookings" TO "authenticated";



GRANT ALL ON TABLE "public"."equipment_request_items" TO "anon";
GRANT ALL ON TABLE "public"."equipment_request_items" TO "authenticated";
GRANT ALL ON TABLE "public"."equipment_request_items" TO "service_role";



GRANT ALL ON TABLE "public"."equipment_request_lines" TO "service_role";
GRANT SELECT ON TABLE "public"."equipment_request_lines" TO "authenticated";



GRANT ALL ON TABLE "public"."equipment_requests" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."equipment_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."equipment_requests" TO "service_role";



GRANT ALL ON TABLE "public"."event_activity_logs" TO "anon";
GRANT ALL ON TABLE "public"."event_activity_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."event_activity_logs" TO "service_role";



GRANT ALL ON TABLE "public"."event_cancellation_requests" TO "anon";
GRANT ALL ON TABLE "public"."event_cancellation_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."event_cancellation_requests" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."event_cancellation_requests" TO "service_role";



GRANT SELECT("event_id") ON TABLE "public"."event_cancellation_requests" TO "service_role";



GRANT SELECT("status"),UPDATE("status") ON TABLE "public"."event_cancellation_requests" TO "service_role";



GRANT ALL ON TABLE "public"."event_change_request_sessions" TO "anon";
GRANT ALL ON TABLE "public"."event_change_request_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."event_change_request_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."event_change_requests" TO "anon";
GRANT ALL ON TABLE "public"."event_change_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."event_change_requests" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."event_change_requests" TO "service_role";



GRANT SELECT("event_id") ON TABLE "public"."event_change_requests" TO "service_role";



GRANT SELECT("status"),UPDATE("status") ON TABLE "public"."event_change_requests" TO "service_role";



GRANT ALL ON TABLE "public"."event_clarifications" TO "anon";
GRANT ALL ON TABLE "public"."event_clarifications" TO "authenticated";
GRANT ALL ON TABLE "public"."event_clarifications" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_registrations" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_registrations" TO "authenticated";
GRANT ALL ON TABLE "public"."event_registrations" TO "service_role";



GRANT ALL ON TABLE "public"."event_safety_reviews" TO "anon";
GRANT ALL ON TABLE "public"."event_safety_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."event_safety_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT UPDATE("is_read") ON TABLE "public"."notifications" TO "authenticated";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."safety_change_request_messages" TO "anon";
GRANT ALL ON TABLE "public"."safety_change_request_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_change_request_messages" TO "service_role";



GRANT ALL ON TABLE "public"."venue_blocks" TO "anon";
GRANT ALL ON TABLE "public"."venue_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_blocks" TO "service_role";



GRANT ALL ON TABLE "public"."venue_bookings" TO "anon";
GRANT ALL ON TABLE "public"."venue_bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_bookings" TO "service_role";



GRANT ALL ON TABLE "public"."venue_edit_history" TO "anon";
GRANT ALL ON TABLE "public"."venue_edit_history" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_edit_history" TO "service_role";



GRANT SELECT ON TABLE "public"."venue_tentative_holds" TO "authenticated";
GRANT SELECT,UPDATE ON TABLE "public"."venue_tentative_holds" TO "service_role";



GRANT ALL ON TABLE "public"."venues" TO "anon";
GRANT ALL ON TABLE "public"."venues" TO "authenticated";
GRANT ALL ON TABLE "public"."venues" TO "service_role";









GRANT SELECT ON TABLE "venue_private"."venue_booking_name_projection" TO "venue_booking_name_reader";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- ADDED BY HAND, not part of the dump (see the note at the top of this file).
-- Removes the temporary permission, so the role matches the live project.
revoke create on schema venue_private from venue_booking_name_reader;
