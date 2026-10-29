// Real PostgreSQL semantics in memory; never connects to shared Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const id = number => '00000000-0000-0000-0000-' + String(number).padStart(12, '0')
const sql = file => readFile(new URL('../../../database/' + file, import.meta.url), 'utf8')

test('automatic previously-confirmed event completion', async t => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to authenticated;
      create table public.profiles(id uuid primary key, role text);
    `)
    await db.query('insert into public.profiles values ($1, $2)', [id(1), 'organiser'])
    await db.query('insert into public.profiles values ($1, $2)', [id(2), 'coordinator'])
    // Use the real event constraints and session-sync trigger.
    for (const file of [
      'events.sql', 'event_drafts.sql', 'event_sessions.sql',
      'event_change_requests.sql', 'event_cancellation_requests.sql',
      'event_change_review.sql', 'event_request_expiry.sql', 'event_completion.sql',
    ]) {
      await db.exec(await sql(file))
    }

    async function createEvent(number, status = 'confirmed', sessions = [['-2 hours', '-1 hour']]) {
      await db.query(`
        insert into public.events (
          id, organiser_id, name, description, purpose, category,
          start_time, end_time, expected_attendance, status, updated_at
        ) values (
          $1, $2, 'Workshop', 'Description', 'Training', 'workshop',
          now() - interval '2 hours', now() - interval '1 hour', 20, $3,
          now() - interval '1 day'
        )
      `, [id(number), id(1), status])
      for (const [start, end] of sessions) {
        await db.query(`
          insert into public.event_sessions(event_id, name, start_time, end_time, expected_attendance)
          values ($1, 'Session', now() + $2::interval, now() + $3::interval, 20)
        `, [id(number), start, end])
      }
    }

    async function completeAs(role = 'service_role') {
      assert.ok(['anon', 'authenticated', 'service_role'].includes(role))
      await db.exec('set role ' + role)
      try {
        return (await db.query('select public.complete_ended_events() as count')).rows[0].count
      } finally {
        await db.exec('reset role')
      }
    }

    const event = async number => (await db.query('select * from public.events where id = $1', [id(number)])).rows[0]
    const snapshot = async () => (await db.query('select to_jsonb(e) as value from public.events e order by id')).rows
    const requests = async () => ({
      changes: (await db.query('select * from public.event_change_requests order by id')).rows,
      cancellations: (await db.query('select * from public.event_cancellation_requests order by id')).rows,
    })
    async function change(number, previous = 'confirmed', status = 'pending') {
      await db.query(`
        insert into public.event_change_requests (
          event_id, organiser_id, event_status_before_request, name, description,
          reason_for_change, purpose, category, start_time, end_time, expected_attendance, status
        ) select id, organiser_id, $2, name, description, 'Change requested',
          purpose, category, start_time, end_time, expected_attendance, $3
        from public.events where id = $1
      `, [id(number), previous, status])
    }
    async function cancellation(number, previous = 'confirmed', status = 'pending') {
      await db.query(`
        insert into public.event_cancellation_requests(event_id, organiser_id, reason, previous_event_status, status)
        select id, organiser_id, 'Cancellation requested', $2, $3 from public.events where id = $1
      `, [id(number), previous, status])
    }
    async function check(name, run) {
      await t.test(name, async () => {
        await db.exec('truncate public.events cascade')
        await run()
      })
    }

    await check('reapplying setup does not run completion or backfill historical timestamps', async () => {
      await createEvent(11)
      await createEvent(12, 'completed')
      const before = await snapshot()
      await db.exec(await sql('event_completion.sql'))
      await db.exec(await sql('event_completion.sql'))
      assert.deepEqual(await snapshot(), before)
      assert.equal((await event(12)).completed_at, null)
    })

    await check('an ended confirmed event completes with the database processing timestamp', async () => {
      await createEvent(11)
      await db.exec('begin')
      try {
        const now = (await db.query('select now() as value')).rows[0].value
        assert.equal(await completeAs(), 1)
        const completed = await event(11)
        assert.equal(completed.status, 'completed')
        assert.deepEqual(completed.completed_at, now)
        assert.deepEqual(completed.updated_at, now)
      } finally {
        await db.exec('commit')
      }
    })

    await check('future confirmed events are unchanged', async () => {
      await createEvent(11, 'confirmed', [['1 hour', '2 hours']])
      const before = await snapshot()
      assert.equal(await completeAs(), 0)
      assert.deepEqual(await snapshot(), before)
    })

    await check('the end time must be strictly earlier than the database clock', async () => {
      await db.exec('begin')
      try {
        await createEvent(11, 'confirmed', [['-1 hour', '0 seconds']])
        assert.equal(await completeAs(), 0)
        assert.equal((await event(11)).status, 'confirmed')
        assert.equal((await event(11)).completed_at, null)
      } finally {
        await db.exec('rollback')
      }
    })

    await check('multiple sessions complete only after the latest session ends', async () => {
      await createEvent(11, 'confirmed', [['-3 hours', '-2 hours'], ['-1 hour', '1 hour']])
      assert.equal(await completeAs(), 0)
      assert.equal((await event(11)).status, 'confirmed')
      await db.query(`
        update public.event_sessions set end_time = now() - interval '30 minutes'
        where event_id = $1 and end_time > now()
      `, [id(11)])
      const synced = await db.query(`
        select end_time = (select max(end_time) from public.event_sessions where event_id = $1) as value
        from public.events where id = $1
      `, [id(11)])
      assert.equal(synced.rows[0].value, true)
      const sessions = await db.query('select * from public.event_sessions order by id')
      assert.equal(await completeAs(), 1)
      assert.equal((await event(11)).status, 'completed')
      assert.deepEqual(await db.query('select * from public.event_sessions order by id'), sessions)
    })

    await check('every other existing event status stays unchanged', async () => {
      const statuses = [
        'draft', 'under_review', 'rejected', 'planning', 'completed',
        'change_requested', 'awaiting_clarification', 'awaiting_safety_check',
        'cancellation_requested', 'cancelled',
      ]
      for (const [index, status] of statuses.entries()) await createEvent(20 + index, status)
      await db.exec("update public.events set completed_at = now() - interval '30 minutes' where status = 'completed'")
      const before = await snapshot()
      assert.equal(await completeAs(), 0)
      assert.deepEqual(await snapshot(), before)
    })

    await check('repeated execution preserves the original completion timestamp', async () => {
      await createEvent(11)
      assert.equal(await completeAs(), 1)
      const before = await snapshot()
      assert.equal(await completeAs(), 0)
      assert.equal(await completeAs(), 0)
      assert.deepEqual(await snapshot(), before)
    })

    await check('confirmed completion expires both pending requests and preserves all history', async () => {
      await createEvent(11)
      for (const status of ['pending', 'approved', 'rejected', 'expired']) {
        await change(11, 'confirmed', status)
        await cancellation(11, 'confirmed', status)
      }
      const before = await requests()
      assert.equal(await completeAs(), 1)
      const expected = Object.fromEntries(Object.entries(before).map(([key, rows]) => [
        key, rows.map(row => ({ ...row, status: row.status === 'pending' ? 'expired' : row.status })),
      ]))
      assert.deepEqual(await requests(), expected)
      assert.equal(await completeAs(), 0)
      assert.deepEqual(await requests(), expected)
    })

    await check('pending changes, cancellations and nested cancellation from confirmed complete', async () => {
      await createEvent(11, 'change_requested')
      await change(11)
      await createEvent(12, 'cancellation_requested')
      await cancellation(12)
      await createEvent(13, 'cancellation_requested')
      await change(13)
      await cancellation(13, 'change_requested')
      assert.equal(await completeAs(), 3)
      for (const number of [11, 12, 13]) assert.equal((await event(number)).status, 'completed')
      const rows = await requests()
      assert.ok([...rows.changes, ...rows.cancellations].every(row => row.status === 'expired'))
    })

    await check('real cancellation submission preserves a pending change and its previous-status chain', async () => {
      await createEvent(11, 'change_requested')
      await change(11)
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id(1)])
      await db.exec('set role authenticated')
      try {
        await db.query('select public.submit_event_cancellation_request($1, $2)', [id(11), 'Please cancel'])
      } finally { await db.exec('reset role') }
      const submitted = await requests()
      assert.equal(submitted.cancellations[0].previous_event_status, 'change_requested')
      assert.equal(submitted.changes[0].event_status_before_request, 'confirmed')
      assert.equal(submitted.changes[0].status, 'pending')
      assert.equal(await completeAs(), 1)
      assert.equal((await requests()).changes[0].status, 'expired')
      assert.equal((await requests()).cancellations[0].status, 'expired')
    })

    await check('unconfirmed origins and missing pending links never infer confirmation from history', async () => {
      for (const [index, previous] of ['under_review', 'planning'].entries()) {
        await createEvent(20 + index, 'change_requested')
        await change(20 + index, previous)
      }
      for (const [index, previous] of ['planning', 'awaiting_safety_check', 'awaiting_clarification'].entries()) {
        await createEvent(30 + index, 'cancellation_requested')
        await cancellation(30 + index, previous)
      }
      await createEvent(40, 'cancellation_requested')
      await change(40, 'planning')
      await cancellation(40, 'change_requested')
      for (const [index, status] of ['approved', 'rejected', 'expired'].entries()) {
        await createEvent(50 + index, 'change_requested')
        await change(50 + index, 'confirmed', status)
        await createEvent(60 + index, 'cancellation_requested')
        await cancellation(60 + index, 'confirmed', status)
        await createEvent(70 + index, 'cancellation_requested')
        await cancellation(70 + index, 'change_requested')
        await change(70 + index, 'confirmed', status)
      }
      // A historical confirmed request must not override the relevant pending one.
      await change(20, 'confirmed', 'approved')
      await cancellation(30, 'confirmed', 'rejected')
      await createEvent(80, 'cancellation_requested')
      await change(80) // A pending change alone is insufficient without a cancellation.
      const before = { events: await snapshot(), requests: await requests() }
      assert.equal(await completeAs(), 0)
      assert.deepEqual({ events: await snapshot(), requests: await requests() }, before)
    })

    await check('pending workflows wait for the final accepted session, ignoring proposed dates', async () => {
      for (const [number, status] of [[11, 'change_requested'], [12, 'cancellation_requested']]) {
        await createEvent(number, status, [['-3 hours', '-2 hours'], ['-1 hour', '1 hour']])
        await change(number)
        if (number === 12) await cancellation(number, 'change_requested')
      }
      assert.equal(await completeAs(), 0)
      await db.exec("update public.event_sessions set end_time = now() - interval '30 minutes' where end_time > now()")
      await db.exec("update public.event_change_requests set end_time = now() + interval '1 day'")
      assert.equal(await completeAs(), 2)
    })

    await check('exact boundary end times do not expire pending requests', async () => {
      await db.exec('begin')
      try {
        await createEvent(11, 'change_requested', [['-1 hour', '0 seconds']])
        await change(11)
        await createEvent(12, 'cancellation_requested', [['-1 hour', '0 seconds']])
        await cancellation(12)
        const before = await requests()
        assert.equal(await completeAs(), 0)
        assert.deepEqual(await requests(), before)
      } finally { await db.exec('rollback') }
    })

    await check('an existing completion timestamp is preserved even on an inconsistent active row', async () => {
      await createEvent(11)
      await db.exec("update public.events set completed_at = now() - interval '1 day'")
      const original = (await event(11)).completed_at
      assert.equal(await completeAs(), 1)
      assert.deepEqual((await event(11)).completed_at, original)
    })

    await check('expiry failure rolls back event completion and both request tables', async () => {
      await createEvent(11, 'cancellation_requested')
      await change(11)
      await cancellation(11, 'change_requested')
      const before = { events: await snapshot(), requests: await requests() }
      await db.exec(`
        create function public.reject_test_expiry() returns trigger language plpgsql as $$
        begin raise exception 'test expiry failure'; end; $$;
        create trigger reject_test_expiry before update on public.event_cancellation_requests
          for each row execute function public.reject_test_expiry();
      `)
      try {
        await assert.rejects(completeAs(), /test expiry failure/)
        assert.deepEqual({ events: await snapshot(), requests: await requests() }, before)
      } finally { await db.exec('drop trigger reject_test_expiry on public.event_cancellation_requests') }
    })

    await check('expired changes cannot be approved or rejected, including a stale coordinator page', async () => {
      await createEvent(11, 'change_requested')
      await change(11)
      await db.query('update public.events set coordinator_id = $1 where id = $2', [id(2), id(11)])
      assert.equal(await completeAs(), 1)
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id(2)])
      await db.exec('set role authenticated')
      try {
        await assert.rejects(db.query('select public.approve_event_change_request($1)', [id(11)]), /no longer pending/)
        await assert.rejects(db.query('select public.reject_event_change_request($1, $2)', [id(11), 'No']), /no longer pending/)
      } finally { await db.exec('reset role') }
      assert.equal((await event(11)).status, 'completed')
    })

    await check('status migration is repeatable, preserves rows and rejects unknown statuses', async () => {
      await createEvent(11)
      await change(11)
      await cancellation(11)
      const before = await requests()
      await db.exec(await sql('event_request_expiry.sql'))
      await db.exec(await sql('event_request_expiry.sql'))
      assert.deepEqual(await requests(), before)
      for (const table of ['event_change_requests', 'event_cancellation_requests']) {
        await assert.rejects(db.exec(`update public.${table} set status = 'invalid'`), /status_valid/)
      }
    })

    await check('completed events reject new pending requests at both table and RPC boundaries', async () => {
      await createEvent(11)
      assert.equal(await completeAs(), 1)
      const before = await snapshot()
      // Table guards also protect missing/new session submission RPCs.
      await assert.rejects(change(11), /cannot be changed in its current status/)
      await assert.rejects(cancellation(11), /cannot be cancelled in its current status/)
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id(1)])
      await db.exec('set role authenticated')
      try {
        await assert.rejects(db.query('select public.submit_event_change_request($1, $2, $3)',
          [id(11), id(1), {}]), /cannot be changed in its current status/)
        await assert.rejects(db.query('select public.submit_event_cancellation_request($1, $2)',
          [id(11), 'Too late']), /cannot be cancelled in its current status/)
      } finally { await db.exec('reset role') }
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual(await requests(), { changes: [], cancellations: [] })
      // Historical imports are not new pending submissions.
      for (const status of ['approved', 'rejected', 'expired']) {
        await change(11, 'confirmed', status)
        await cancellation(11, 'confirmed', status)
      }
      assert.deepEqual(await snapshot(), before)
    })

    await check('organisers and assigned coordinators retain completed-event access under real RLS', async () => {
      await createEvent(11)
      await db.query('update public.events set coordinator_id = $1 where id = $2', [id(2), id(11)])
      assert.equal(await completeAs(), 1)
      for (const user of [id(1), id(2)]) {
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user])
        await db.exec('set role authenticated')
        try {
          const visible = (await db.query('select id, status, completed_at from public.events')).rows
          assert.equal(visible.length, 1)
          assert.equal(visible[0].status, 'completed')
          assert.ok(visible[0].completed_at)
        } finally { await db.exec('reset role') }
      }
    })

    await check('anonymous and signed-in callers cannot invoke system completion', async () => {
      await createEvent(11)
      const before = await snapshot()
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(completeAs(role), /permission denied for function complete_ended_events/)
      }
      assert.deepEqual(await snapshot(), before)
      assert.equal(await completeAs(), 1)
    })

    await check('failure rolls back the entire completion pass', async () => {
      await createEvent(11)
      await createEvent(12)
      const before = await snapshot()
      await db.exec(`
        create function public.reject_test_completion() returns trigger language plpgsql as $$
        begin
          if new.id = '00000000-0000-0000-0000-000000000012'::uuid then
            raise exception 'test completion failure';
          end if;
          return new;
        end;
        $$;
        create trigger reject_test_completion before update on public.events
          for each row execute function public.reject_test_completion();
      `)
      try {
        await assert.rejects(completeAs(), /test completion failure/)
        assert.deepEqual(await snapshot(), before)
      } finally {
        await db.exec('drop trigger reject_test_completion on public.events')
      }
    })

    await check('a batch larger than the Data API row limit returns its full count', async () => {
      await db.query(`
        insert into public.events (
          organiser_id, name, description, purpose, category,
          start_time, end_time, expected_attendance, status
        )
        select $1::uuid, 'Workshop', 'Description', 'Training', 'workshop',
          now() - interval '2 hours', now() - interval '1 hour', 20, 'confirmed'
        from generate_series(1, 1001)
      `, [id(1)])
      assert.equal(await completeAs(), 1001)
      assert.equal(await completeAs(), 0)
    })
  } finally {
    await db.close()
  }
})
