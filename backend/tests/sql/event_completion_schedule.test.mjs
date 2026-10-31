// Configuration verification in PostgreSQL with a fixture for pg_cron's APIs.
// PGlite has no cron worker: this suite never claims to test timed execution.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const sql = file => readFile(new URL('../../../database/' + file, import.meta.url), 'utf8')
const jobName = 'connectsphere-complete-ended-events'

// Match the documented signatures, named-job upsert, execution identity and
// initial active=true behaviour that the installer must handle atomically.
const cronApiFixture = `
  create schema cron;
  create table cron.job (
    jobid bigint generated always as identity primary key,
    jobname text not null,
    schedule text not null,
    command text not null,
    database text not null default current_database(),
    username text not null default current_user,
    active boolean not null default true,
    unique(jobname, username)
  );
  create function cron.schedule(text, text, text) returns bigint
  language sql security invoker as $$
    insert into cron.job(jobname, schedule, command) values ($1, $2, $3)
    on conflict(jobname, username) do update
      set schedule = excluded.schedule, command = excluded.command, active = true
    returning jobid;
  $$;
  create function cron.alter_job(
    job_id bigint, schedule text default null, command text default null,
    database text default null, username text default null, active boolean default null
  ) returns void language sql security invoker as $$
    update cron.job j set
      schedule = coalesce($2, j.schedule), command = coalesce($3, j.command),
      database = coalesce($4, j.database), username = coalesce($5, j.username),
      active = coalesce($6, j.active)
    where j.jobid = $1;
  $$;
`

test('database-native completion schedule configuration (cron API fixture)', async t => {
  const db = new PGlite()
  const setup = await sql('event_completion_schedule.sql')
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      grant usage on schema auth to authenticated;
      create table public.profiles(id uuid primary key, role text);
      insert into public.profiles values ('00000000-0000-0000-0000-000000000001', 'organiser');
    `)
    for (const file of [
      'events.sql', 'event_drafts.sql', 'event_sessions.sql',
      'event_change_requests.sql', 'event_cancellation_requests.sql', 'event_request_expiry.sql',
    ]) {
      await db.exec(await sql(file))
    }

    await t.test('missing Cron dependency fails without installing anything', async () => {
      await assert.rejects(db.exec(setup), /Enable Supabase Cron/)
      assert.equal((await db.query("select to_regclass('cron.job') as value")).rows[0].value, null)
    })
    await db.exec(cronApiFixture)
    await t.test('missing completion function fails without creating a job', async () => {
      await assert.rejects(db.exec(setup), /Apply database\/event_completion.sql/)
      assert.equal((await db.query('select count(*)::int as count from cron.job')).rows[0].count, 0)
    })
    await db.exec(await sql('event_completion.sql'))

    const jobs = async () => (await db.query('select * from cron.job order by jobid')).rows
    const job = async () => (await jobs()).find(row => row.jobname === jobName)
    async function createEndedEvent() {
      await db.exec(`
        insert into public.events (
          organiser_id, name, description, purpose, category, status,
          start_time, end_time, expected_attendance
        ) values (
          '00000000-0000-0000-0000-000000000001', 'Workshop', 'Description',
          'Training', 'workshop', 'confirmed', now() - interval '2 hours',
          now() - interval '1 hour', 20
        );
      `)
    }
    async function check(name, run) {
      await t.test(name, async () => {
        await db.exec('truncate cron.job; truncate public.events cascade')
        await run()
      })
    }

    await check('only the fixed database administrator role may install the job', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await db.exec('set role ' + role)
        try {
          await assert.rejects(db.exec(setup), /as the postgres database role/)
        } finally {
          await db.exec('reset role')
        }
      }
      assert.deepEqual(await jobs(), [])
    })

    await check('new job has every-minute cadence, correct identity and inactive default', async () => {
      await createEndedEvent()
      await db.exec(setup)
      const installed = await job()
      assert.equal((await jobs()).length, 1)
      assert.equal(installed.schedule, '* * * * *')
      assert.equal(installed.username, 'postgres')
      assert.equal(installed.database, (await db.query('select current_database() as value')).rows[0].value)
      assert.equal(installed.active, false)
      assert.match(installed.command, /set local role service_role;/)
      assert.match(installed.command, /set local statement_timeout = '45s';/)
      assert.match(installed.command, /set local lock_timeout = '5s';/)
      assert.match(installed.command, /select public.complete_ended_events\(\);/)
      const event = (await db.query('select status, completed_at from public.events')).rows[0]
      assert.deepEqual(event, { status: 'confirmed', completed_at: null })
    })

    await check('reapplying keeps one inactive job and leaves other jobs unchanged', async () => {
      await db.query('select cron.schedule($1, $2, $3)', ['another-job', '0 * * * *', 'select 1;'])
      const otherBefore = (await jobs())[0]
      await db.exec(setup)
      const installed = await job()
      await db.exec(setup)
      assert.deepEqual(await job(), installed)
      assert.equal((await jobs()).length, 2)
      assert.deepEqual((await jobs()).find(row => row.jobname === 'another-job'), otherBefore)
    })

    await check('reapplying preserves explicitly activated and subsequently paused states', async () => {
      await db.exec(setup)
      const identity = (await job()).jobid
      await db.query('select cron.alter_job($1, active := true)', [identity])
      await db.exec(setup)
      assert.equal((await job()).active, true)
      assert.equal((await job()).jobid, identity)
      await db.query('select cron.alter_job($1, active := false)', [identity])
      await db.exec(setup)
      assert.equal((await job()).active, false)
      assert.equal((await job()).jobid, identity)
    })

    await check('stored command runs under existing system permissions and is repeatable', async () => {
      await createEndedEvent()
      await db.exec(setup)
      const installed = await job()
      const timeoutBefore = await db.query("select current_setting('statement_timeout') as value")
      await db.exec(installed.command)
      const completed = await db.query('select status, completed_at, updated_at from public.events')
      assert.equal(completed.rows[0].status, 'completed')
      assert.ok(completed.rows[0].completed_at)
      await db.exec(installed.command)
      assert.deepEqual(await db.query('select status, completed_at, updated_at from public.events'), completed)
      assert.equal((await db.query('select current_user as value')).rows[0].value, 'postgres')
      assert.deepEqual(await db.query("select current_setting('statement_timeout') as value"), timeoutBefore)
    })

    await check('missing system function permission prevents installation', async () => {
      await db.exec('revoke execute on function public.complete_ended_events() from service_role')
      try {
        await assert.rejects(db.exec(setup), /service_role needs public schema USAGE and completion function EXECUTE/)
        assert.deepEqual(await jobs(), [])
      } finally {
        await db.exec('grant execute on function public.complete_ended_events() to service_role')
      }
    })

    await check('missing timestamp update permission prevents installation', async () => {
      await db.exec('revoke update (completed_at) on public.events from service_role')
      try {
        await assert.rejects(db.exec(setup), /service_role needs UPDATE on events.completed_at/)
        assert.deepEqual(await jobs(), [])
      } finally {
        await db.exec('grant update (completed_at) on public.events to service_role')
      }
    })

    await check('RLS cannot silently hide events from the scheduled operation', async () => {
      await db.exec('alter role service_role nobypassrls')
      try {
        await assert.rejects(db.exec(setup), /must bypass events row-level security/)
        assert.deepEqual(await jobs(), [])
      } finally {
        await db.exec('alter role service_role bypassrls')
      }
    })

    await check('an existing job for another database is not overwritten', async () => {
      await db.query('select cron.schedule($1, $2, $3)', [jobName, '* * * * *', 'select 1;'])
      await db.exec("update cron.job set database = 'another_database'")
      const before = await jobs()
      await assert.rejects(db.exec(setup), /already belongs to another database/)
      assert.deepEqual(await jobs(), before)
    })

    await check('failure while setting inactive rolls back job creation', async () => {
      const original = (await db.query(`
        select pg_get_functiondef('cron.alter_job(bigint,text,text,text,text,boolean)'::regprocedure) as value
      `)).rows[0].value
      await db.exec(`
        create or replace function cron.alter_job(
          job_id bigint, schedule text default null, command text default null,
          database text default null, username text default null, active boolean default null
        ) returns void language plpgsql as $$begin raise exception 'fixture alteration failure'; end;$$;
      `)
      try {
        await assert.rejects(db.exec(setup), /fixture alteration failure/)
        assert.deepEqual(await jobs(), [])
      } finally {
        await db.exec(original)
      }
    })
  } finally {
    await db.close()
  }
})
