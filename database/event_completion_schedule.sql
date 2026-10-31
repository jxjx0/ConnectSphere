-- Optional Supabase Cron setup. Run only after deployment approval.
-- Prerequisites: pg_cron enabled, event_completion.sql and
-- event_status_badges.sql applied.
-- A new job is INACTIVE. Activate separately after reviewing its configuration.
-- Reapplying preserves an existing job's active/paused state.
-- The DO block is one transaction: the worker never sees an interim active job.
do $setup$
declare
    completion_job bigint;
    previous_active boolean;
    previous_database text;
    required_column text;
begin
    -- A fixed owner prevents duplicate named jobs under different deployers.
    if current_user <> 'postgres' then
        raise exception 'Run the completion scheduler setup as the postgres database role';
    end if;

    if to_regclass('cron.job') is null
        or to_regprocedure('cron.schedule(text,text,text)') is null
        or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
        raise exception 'Enable Supabase Cron (pg_cron) before configuring completion';
    end if;
    if to_regprocedure('public.complete_ended_events()') is null then
        raise exception 'Apply database/event_completion.sql before configuring completion';
    end if;

    select j.active, j.database into previous_active, previous_database
    from cron.job j
    where j.jobname = 'connectsphere-complete-ended-events'
      and j.username = current_user;
    if previous_database is not null and previous_database <> current_database() then
        raise exception 'The completion job already belongs to another database; review it before proceeding';
    end if;

    -- Verify the exact role used by the job rather than relying on DBA privileges.
    -- SET LOCAL also proves that the job owner can assume this role.
    set local role service_role;
    if not has_schema_privilege(current_user, 'public', 'USAGE')
        or not has_function_privilege(current_user, 'public.complete_ended_events()', 'EXECUTE') then
        raise exception 'service_role needs public schema USAGE and completion function EXECUTE';
    end if;
    foreach required_column in array array['id', 'status', 'end_time', 'completed_at'] loop
        if not has_column_privilege(current_user, 'public.events', required_column, 'SELECT') then
            raise exception 'service_role needs SELECT on events.%', required_column;
        end if;
    end loop;
    foreach required_column in array array['status', 'completed_at', 'updated_at'] loop
        if not has_column_privilege(current_user, 'public.events', required_column, 'UPDATE') then
            raise exception 'service_role needs UPDATE on events.%', required_column;
        end if;
    end loop;
    if row_security_active('public.events'::regclass) then
        raise exception 'service_role must bypass events row-level security for system completion';
    end if;
    -- Open change and cancellation requests are expired by the
    -- events_expire_open_requests trigger (database/event_status_badges.sql),
    -- which runs with its own privileges, so the job needs none on those tables.
    set local role postgres;

    completion_job := cron.schedule(
        'connectsphere-complete-ended-events',
        '* * * * *',
        $job$begin;
set local role service_role;
set local statement_timeout = '45s';
set local lock_timeout = '5s';
select public.complete_ended_events();
commit;$job$
    );
    perform cron.alter_job(
        job_id := completion_job,
        active := coalesce(previous_active, false)
    );

    if not exists (
        select 1 from cron.job j
        where j.jobid = completion_job and j.username = current_user
          and j.database = current_database()
    ) then
        raise exception 'Unexpected completion job owner or database; scheduler setup rolled back';
    end if;
end;
$setup$;
