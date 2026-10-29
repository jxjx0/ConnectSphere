// Real multi-connection PostgreSQL tests. Creates a disposable loopback-only
// cluster; never reads application credentials or connects to shared Supabase.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'

const modulePath = process.env.COMPLETION_TEST_POSTGRES_MODULE || 'embedded-postgres'
const { default: EmbeddedPostgres } = await import(modulePath)
const sql = file => readFile(new URL('../../../database/' + file, import.meta.url), 'utf8')
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')

test('completion with simultaneous reviews and runners (isolated PostgreSQL)', { timeout: 60000 }, async t => {
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const cluster = new EmbeddedPostgres({
    databaseDir: join(await mkdtemp(join(tmpdir(), 'connectsphere-completion-')), 'db'),
    user: 'postgres', password: 'local-completion-test', port, persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {}, onError: () => {},
  })
  const clients = []
  try {
    await cluster.initialise()
    await cluster.start()
    for (let n = 0; n < 3; n++) {
      const client = cluster.getPgClient()
      await client.connect()
      await client.query("set statement_timeout = '5s'")
      clients.push(client)
    }
    const [admin, worker, reviewer] = clients
    await admin.query(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      create table public.profiles(id uuid primary key, role text);
      insert into public.profiles values ('${id(1)}','organiser'),('${id(2)}','coordinator');
    `)
    for (const file of [
      'events.sql', 'event_drafts.sql', 'event_sessions.sql', 'event_change_requests.sql',
      'event_cancellation_requests.sql', 'event_change_review.sql',
      'event_request_expiry.sql', 'event_completion.sql',
    ]) await admin.query(await sql(file))
    await worker.query('set role service_role')
    await reviewer.query('set role authenticated')
    await reviewer.query("select set_config('request.jwt.claim.sub',$1,false)", [id(2)])

    async function fixture() {
      await admin.query('truncate public.events cascade')
      await admin.query(`
        insert into public.events(id,organiser_id,coordinator_id,name,description,purpose,category,
          status,start_time,end_time,expected_attendance)
        values ($1,$2,$3,'Workshop','Description','Training','workshop','change_requested',
          now()-interval '2 hours',now()-interval '1 hour',20);
      `, [id(11), id(1), id(2)])
      await admin.query(`
        insert into public.event_change_requests(event_id,organiser_id,event_status_before_request,
          name,description,reason_for_change,purpose,category,start_time,end_time,expected_attendance)
        select id,organiser_id,'confirmed',name,description,'New date',purpose,category,
          now()+interval '1 day',now()+interval '2 days',expected_attendance from public.events;
      `)
    }
    const complete = client => client.query('select public.complete_ended_events() as count')
    const snapshot = async () => (await admin.query(`
      select e.status, e.completed_at, r.status as request_status
      from public.events e join public.event_change_requests r on r.event_id=e.id
    `)).rows[0]

    for (const decision of ['approve', 'reject']) {
      await t.test(`completion skips a request locked by ${decision} review; retries use committed state`, async () => {
        await fixture()
        await reviewer.query('begin')
        try {
          // Reproduce the existing review's request-before-event lock order.
          // The RPC takes this lock as SECURITY DEFINER; authenticated has no UPDATE grant.
          await reviewer.query('set local role postgres')
          await reviewer.query("select id from public.event_change_requests where status='pending' for update")
          await reviewer.query('set local role authenticated')
          assert.equal((await complete(worker)).rows[0].count, 0)
          const query = decision === 'approve'
            ? 'select public.approve_event_change_request($1)'
            : "select public.reject_event_change_request($1, 'Keep original schedule')"
          await reviewer.query(query, [id(11)])
          await reviewer.query('commit')
          // Approval moved the event into the future; rejection kept its ended schedule.
          assert.equal((await complete(worker)).rows[0].count, decision === 'approve' ? 0 : 1)
          const after = await snapshot()
          assert.equal(after.request_status, decision === 'approve' ? 'approved' : 'rejected')
          assert.equal(after.status, decision === 'approve' ? 'confirmed' : 'completed')
        } finally { await reviewer.query('rollback') }
      })

      await t.test(`${decision} review started during completion cannot revive an expired request`, async () => {
        await fixture()
        await worker.query('begin')
        let pending
        try {
          assert.equal((await complete(worker)).rows[0].count, 1)
          const query = decision === 'approve'
            ? 'select public.approve_event_change_request($1)'
            : "select public.reject_event_change_request($1, 'Too late')"
          pending = reviewer.query(query, [id(11)]).then(
            () => { throw new Error('Review unexpectedly succeeded') },
            error => error,
          )
          const pid = (await admin.query("select pid from pg_stat_activity where query=$1 and wait_event_type='Lock'", [query])).rows
          // Wait on observable lock state, not an arbitrary sleep/race.
          let waiting = pid.length > 0
          const deadline = Date.now() + 3000
          while (!waiting && Date.now() < deadline) {
            waiting = (await admin.query("select 1 from pg_stat_activity where query=$1 and wait_event_type='Lock'", [query])).rows.length > 0
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
          }
          assert.ok(waiting, 'review must actually overlap completion')
          await worker.query('commit')
          assert.match((await pending).message, /no longer pending/)
          const after = await snapshot()
          assert.equal(after.status, 'completed')
          assert.equal(after.request_status, 'expired')
          const timestamp = after.completed_at
          assert.equal((await complete(worker)).rows[0].count, 0)
          assert.deepEqual((await snapshot()).completed_at, timestamp)
        } finally {
          await worker.query('rollback')
          if (pending) await pending
        }
      })
    }

    await t.test('overlapping completion runners skip locked events and preserve the timestamp', async () => {
      await fixture()
      await admin.query('begin')
      try {
        assert.equal((await complete(admin)).rows[0].count, 1)
        assert.equal((await complete(worker)).rows[0].count, 0)
        await admin.query('commit')
        const before = await snapshot()
        assert.equal((await complete(worker)).rows[0].count, 0)
        assert.deepEqual(await snapshot(), before)
      } finally { await admin.query('rollback') }
    })

    for (const kind of ['change', 'cancellation']) {
      await t.test(`a new ${kind} request waiting on completion cannot be inserted afterwards`, async () => {
        await fixture()
        await worker.query('begin')
        let pending
        try {
          assert.equal((await complete(worker)).rows[0].count, 1)
          const query = kind === 'change' ? `
            insert into public.event_change_requests(event_id,organiser_id,event_status_before_request,
              name,description,reason_for_change,purpose,category,start_time,end_time,expected_attendance)
            select id,organiser_id,'confirmed',name,description,'Late change',purpose,category,
              start_time,end_time,expected_attendance from public.events
          ` : `
            insert into public.event_cancellation_requests(event_id,organiser_id,reason,previous_event_status)
            select id,organiser_id,'Late cancellation','confirmed' from public.events
          `
          pending = admin.query(query).then(() => null, error => error)
          let waiting = false
          const deadline = Date.now() + 3000
          while (!waiting && Date.now() < deadline) {
            waiting = (await reviewer.query(
              'select pg_blocking_pids($1)::text as blockers', [admin.processID],
            )).rows[0].blockers !== '{}'
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
          }
          assert.ok(waiting, 'request insertion must overlap completion')
          await worker.query('commit')
          assert.match((await pending)?.message || '', /cannot be changed|cannot be cancelled/)
          assert.equal((await snapshot()).request_status, 'expired')
          assert.equal((await admin.query("select count(*)::int as count from public.event_cancellation_requests where status='pending'")).rows[0].count, 0)
        } finally {
          await worker.query('rollback')
          if (pending) await pending
        }
      })
    }

    await t.test('a cancellation row lock defers the entire nested completion without partial expiry', async () => {
      await fixture()
      await admin.query(`
        insert into public.event_cancellation_requests(event_id,organiser_id,reason,previous_event_status)
        values ('${id(11)}','${id(1)}','Cancel','change_requested');
        update public.events set status='cancellation_requested';
      `)
      // No cancellation review RPC exists in this repository: exercise its row lock.
      await admin.query('begin')
      try {
        await admin.query('select id from public.event_cancellation_requests for update')
        assert.equal((await complete(worker)).rows[0].count, 0)
        assert.equal((await snapshot()).request_status, 'pending')
      } finally { await admin.query('rollback') }
      assert.equal((await complete(worker)).rows[0].count, 1)
      assert.equal((await snapshot()).request_status, 'expired')
      assert.equal((await admin.query('select status from public.event_cancellation_requests')).rows[0].status, 'expired')
    })
  } finally {
    for (const client of clients) await client.end()
    await cluster.stop()
  }
})
