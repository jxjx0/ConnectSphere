// Integrate completion with the actual attendee migration, supplied separately
// until PR #50 is available on this branch. No replacement registration schema.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const sql = file => readFile(new URL('../../../database/' + file, import.meta.url), 'utf8')
const migration = process.env.COMPLETION_TEST_REGISTRATION_SQL
  || new URL('../../../database/attendee_registrations.sql', import.meta.url)
let registrationSql
try { registrationSql = await readFile(migration, 'utf8') } catch (error) {
  if (error.code !== 'ENOENT' || process.env.COMPLETION_TEST_REGISTRATION_SQL) throw error
}
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')

test('completion integrated with attendee registration migration', {
  skip: registrationSql ? false : 'Requires attendee_registrations.sql from T7-36 / PR #50',
}, async t => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text not null);
      insert into auth.users values
        ('${id(2)}','attendee2@example.test'),
        ('${id(3)}','attendee3@example.test');
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      create table public.profiles(id uuid primary key, role text);
      insert into public.profiles values ('${id(1)}','organiser'),
        ('${id(2)}','attendee'),('${id(3)}','attendee');
    `)
    for (const file of ['events.sql', 'event_drafts.sql', 'event_sessions.sql',
      'event_change_requests.sql', 'event_cancellation_requests.sql', 'event_request_expiry.sql',
      'event_completion.sql']) await db.exec(await sql(file))
    // Only unrelated arrangement tables are minimal fixtures. The completion,
    // registration, publication and RLS code under test is the real SQL.
    await db.exec(`
      create table public.venues(id uuid primary key,name text,location text,capacity int);
      create table public.venue_bookings(booking_id uuid,venue_id uuid,event_id uuid,session_id uuid,status text);
      create table public.equipment_requests(id uuid,event_id uuid,session_id uuid,status text);
      create table public.event_safety_reviews(event_id uuid,decision text,created_at timestamptz);
    `)
    await db.exec(await sql('event_registration.sql'))
    await db.exec(registrationSql)
    const asAttendee = async (user, query, params = []) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id(user)])
      await db.exec('set role authenticated')
      try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
    }
    const register = user => asAttendee(user,
      'select public.register_for_event($1,$2,$3)',
      [id(11), 'Attendee', '12345678'])
    await db.exec(`
      insert into public.events(id,organiser_id,name,description,purpose,category,status,
        start_time,end_time,expected_attendance,published_at,
        registration_opens_at,registration_closes_at,attendee_capacity)
      values ('${id(11)}','${id(1)}','Workshop','Description','Training','workshop','confirmed',
        now()+interval '1 hour',now()+interval '2 hours',20,now(),
        now()-interval '1 day',now()+interval '1 day',20);
      insert into public.event_sessions(event_id,name,start_time,end_time,expected_attendance)
      values ('${id(11)}','Final session',now()+interval '1 hour',now()+interval '2 hours',20);
    `)
    await t.test('confirmed event accepts a registration before completion', async () => {
      await register(2)
      assert.equal((await db.query('select count(*)::int as count from public.event_registrations')).rows[0].count, 1)
    })
    await db.exec(`update public.event_sessions set start_time=now()-interval '2 hours',
      end_time=now()-interval '1 hour'; set role service_role;`)
    try {
      assert.equal((await db.query('select public.complete_ended_events() as count')).rows[0].count, 1)
    } finally { await db.exec('reset role') }
    await t.test('completed event refuses a new attendee even with an open registration window', async () => {
      // The fixture deliberately leaves the window open to isolate the status guard.
      await assert.rejects(register(3), /Event was not found/)
      assert.equal((await db.query('select count(*)::int as count from public.event_registrations')).rows[0].count, 1)
    })
    await t.test('completed event disappears from published events but existing registration history survives', async () => {
      assert.deepEqual(await asAttendee(3, 'select * from public.list_published_events()'), [])
      const history = await asAttendee(2, 'select * from public.list_my_registrations()')
      assert.equal(history.length, 1)
      assert.equal(history[0].event_status, 'completed')
      assert.equal(history[0].event_id, id(11))
    })
    await t.test('an attendee cannot bypass the RPC with a direct insert', async () => {
      await assert.rejects(asAttendee(3, `insert into public.event_registrations(
        event_id,attendee_id,full_name,email,address,contact_number)
        values ($1,$2,'Attendee','bypass@example.test','Test address','12345678')`, [id(11), id(3)]),
      /permission denied|row-level security/)
    })
  } finally { await db.close() }
})
