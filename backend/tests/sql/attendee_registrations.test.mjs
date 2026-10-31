// Isolated PostgreSQL integration: no connection to Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const sql = file => readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8')
// Users: 1, 2 and 3 attendees, 4 organiser, 5 attendee without an email.
// Events: 21 open with 2 places, 22 confirmed but unpublished,
// 23 registration closed, 24 registration not yet open. Organiser 4 owns 21.
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table auth.users(id uuid primary key,email text);
insert into auth.users values ('${id(1)}',' Cara@Example.com '),('${id(2)}','user02@example.com'),('${id(3)}','user03@example.com'),('${id(4)}','org@example.com'),('${id(5)}',null);
create table public.profiles(id uuid primary key,role text);
create table public.events(id uuid primary key,name text,description text,purpose text,category text,category_other text,
  start_time timestamptz,end_time timestamptz,accessibility_requirements text,status text,
  registration_opens_at timestamptz,registration_closes_at timestamptz,attendee_capacity int,published_at timestamptz,
  organiser_id uuid);
create table public.event_sessions(id uuid primary key,event_id uuid,name text,start_time timestamptz,end_time timestamptz);
create table public.venues(id uuid primary key,name text,location text);
create table public.venue_bookings(booking_id uuid primary key,venue_id uuid,session_id uuid,status text);
insert into public.profiles values ('${id(1)}','attendee'),('${id(2)}','attendee'),('${id(3)}','attendee'),('${id(4)}','organiser'),('${id(5)}','attendee');
insert into public.events(id,name,status,start_time,registration_opens_at,registration_closes_at,attendee_capacity,published_at) values
  ('${id(21)}','Open','confirmed','2099-12-01',now()-interval '1 day','2099-11-01',2,now()),
  ('${id(22)}','Unpublished','confirmed','2099-12-01',now()-interval '1 day','2099-11-01',2,null),
  ('${id(23)}','Closed','confirmed','2099-12-01',now()-interval '2 days',now()-interval '1 day',2,now()),
  ('${id(24)}','Not open','confirmed','2099-12-01','2099-10-01','2099-11-01',2,now());
insert into public.event_sessions values ('${id(31)}','${id(21)}','Main','2099-12-01T09:00Z','2099-12-01T17:00Z');
insert into public.venues values ('${id(11)}','Hall','Campus West');
insert into public.venue_bookings values ('${id(41)}','${id(11)}','${id(31)}','APPROVED');
`)
await db.exec(await sql('attendee_registrations.sql'))
await db.exec(await sql('attendee_registrations.sql')) // Safe to run twice.

async function asUser(user, query, params = []) {
  await db.exec('set role authenticated')
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user])
  try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
}
const register = (user, event, contactNumber = '+65 9123 4567') => asUser(
  user, 'select public.register_for_event($1,$2,$3) as id',
  [event, 'Cara Ng', contactNumber],
)
const listAs = (user, event = null) => asUser(user, 'select * from public.list_published_events($1)', [event])
const count = async () => (await db.query('select count(*)::int as n from public.event_registrations')).rows[0].n

// Only confirmed, published events are listed, with their approved venue.
const listed = await listAs(id(1))
assert.deepEqual(listed.map(row => row.name).sort(), ['Closed', 'Not open', 'Open'])
const open = (await listAs(id(1), id(21)))[0]
assert.equal(open.spots_left, 2)
assert.equal(open.is_registered, false)
assert.equal(open.sessions[0].venue_name, 'Hall')
assert.deepEqual(await listAs(id(1), id(22)), [])

// Only a signed-in attendee can register.
await assert.rejects(register(id(4), id(21)), /signed-in attendee/)
await assert.rejects(register('', id(21)), /signed-in attendee/)

// Unpublished, closed and not-yet-open events refuse registration.
await assert.rejects(register(id(1), id(22)), /not found/)
await assert.rejects(register(id(1), id(23)), /has closed/)
await assert.rejects(register(id(1), id(24)), /not opened yet/)
await assert.rejects(register(id(5), id(21)), /has no email address/)
assert.equal(await count(), 0)

// A registration is saved under the account email and lowers the spots left by one.
const [saved] = await register(id(1), id(21))
assert.ok(saved.id)
const afterOne = (await listAs(id(1), id(21)))[0]
assert.equal(afterOne.spots_left, 1)
assert.equal(afterOne.is_registered, true)
assert.equal((await listAs(id(2), id(21)))[0].is_registered, false)

// The same account cannot register twice.
await assert.rejects(register(id(1), id(21)), /account is already registered/)
assert.equal(await count(), 1)

// The last spot goes, then the event is full and nothing more is saved.
// The contact number is optional; a blank one is saved as null.
await register(id(2), id(21), '   ')
assert.equal((await listAs(id(1), id(21)))[0].spots_left, 0)
await assert.rejects(register(id(3), id(21)), /Event is full/)
assert.equal(await count(), 2)

// Each attendee's registrations come back with their event.
const mine = await asUser(id(1), 'select * from public.list_my_registrations($1)', [null])
assert.equal(mine.length, 1)
assert.equal(mine[0].event_name, 'Open')
assert.equal(mine[0].email, 'cara@example.com')
assert.equal(mine[0].contact_number, '+65 9123 4567')
assert.equal('address' in mine[0], false)
const withoutContact = await asUser(id(2), 'select * from public.list_my_registrations($1)', [null])
assert.equal(withoutContact[0].contact_number, null)
assert.equal((await asUser(id(1), 'select * from public.list_my_registrations($1)', [saved.id])).length, 1)
assert.deepEqual(await asUser(id(3), 'select * from public.list_my_registrations($1)', [saved.id]), [])

// Attendees only see their own registrations; nobody inserts directly.
assert.equal((await asUser(id(1), 'select * from public.event_registrations')).length, 1)
await assert.rejects(asUser(id(3), `insert into public.event_registrations(event_id,attendee_id,full_name,email,address,contact_number)
  values ('${id(21)}','${id(3)}','x','x@example.com','x','12345678')`))

// The owning organiser sees only how many signed up; nobody else sees a count.
const signUps = (user, event) => asUser(user, 'select public.count_event_registrations($1) as n', [event])
await db.query('update public.events set organiser_id=$1 where id=$2', [id(4), id(21)])
assert.equal((await signUps(id(4), id(21)))[0].n, 2)
assert.equal((await signUps(id(4), id(23)))[0].n, null)
assert.equal((await signUps(id(1), id(21)))[0].n, null)
assert.equal((await signUps('', id(21)))[0].n, null)
