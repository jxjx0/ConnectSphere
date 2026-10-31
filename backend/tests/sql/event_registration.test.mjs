// Isolated PostgreSQL integration: no connection to Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const sql = file => readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8')
// Users: 1 organiser who owns the events, 2 another organiser, 3 coordinator.
// Events: 21 has two sessions (31, 32); 22 is still under review.
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table public.profiles(id uuid primary key,role text);
create function public.is_organiser() returns boolean language sql stable as $$select exists(select 1 from public.profiles where id=auth.uid() and role='organiser')$$;
create table public.events(id uuid primary key,organiser_id uuid,status text,start_time timestamptz);
create table public.event_sessions(id uuid primary key,event_id uuid);
create table public.venues(id uuid primary key,name text,location text,capacity int);
create table public.venue_bookings(booking_id uuid primary key,venue_id uuid,event_id uuid,session_id uuid,status text);
create table public.equipment_requests(id uuid primary key,event_id uuid,session_id uuid,status text);
create table public.event_safety_reviews(id uuid primary key default gen_random_uuid(),event_id uuid,decision text,created_at timestamptz default now());
insert into public.profiles values ('${id(1)}','organiser'),('${id(2)}','organiser'),('${id(3)}','coordinator');
insert into public.events values ('${id(21)}','${id(1)}','planning','2099-12-01T09:00Z'),('${id(22)}','${id(1)}','under_review','2099-12-01T09:00Z');
insert into public.event_sessions values ('${id(31)}','${id(21)}'),('${id(32)}','${id(21)}');
insert into public.venues values ('${id(11)}','Hall','Campus West',200),('${id(12)}','Room','Campus East',80);
insert into public.venue_bookings values
  ('${id(41)}','${id(11)}','${id(21)}','${id(31)}','APPROVED'),
  ('${id(42)}','${id(12)}','${id(21)}','${id(32)}','PENDING_VENUE_APPROVAL'),
  ('${id(43)}','${id(12)}','${id(21)}','${id(32)}','CANCELLED');
insert into public.equipment_requests values
  ('${id(51)}','${id(21)}','${id(31)}','Pending Technical Approval'),
  ('${id(52)}','${id(21)}',null,'Rejected');
grant select on all tables in schema public to authenticated;
`)
await db.exec(await sql('event_registration.sql'))
await db.exec(await sql('event_registration.sql')) // Safe to run twice.

async function asUser(role, user, query, params = []) {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user])
  try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
}
const save = 'select public.save_event_registration($1,$2,$3,$4,$5)'
const settings = (changes = {}) => {
  const values = [id(21), '2099-11-01T09:00Z', '2099-11-20T09:00Z', 80, false]
  Object.entries(changes).forEach(([key, value]) => { values[Number(key)] = value })
  return values
}
const saveAs = (user, changes) => asUser('authenticated', user, save, settings(changes))
const event = async () => (await db.query('select * from public.events where id=$1', [id(21)])).rows[0]

// Only the signed-in organiser who owns the event.
await assert.rejects(asUser('anon', '', save, settings()))
await assert.rejects(saveAs(id(3)), /signed-in organiser/)
await assert.rejects(saveAs(id(2)), /not found/)
await assert.rejects(saveAs(id(1), { 0: id(22) }), /current status/)
// A stale organiser page cannot save or publish registration after completion.
await db.query("update public.events set status='completed' where id=$1", [id(21)])
await assert.rejects(saveAs(id(1)), /current status/)
await assert.rejects(saveAs(id(1), { 4: true }), /current status/)
await db.query("update public.events set status='planning' where id=$1", [id(21)])

// Validation.
await assert.rejects(saveAs(id(1), { 2: '2099-11-01T09:00Z' }), /close after it opens/)
await assert.rejects(saveAs(id(1), { 2: '2099-12-01T09:01Z' }), /before the event starts/)
await assert.rejects(saveAs(id(1), { 3: 0 }))

// Saving works while approvals are pending; publishing does not. The venue
// limit waits until every session's venue is approved, so it is not yet known.
await saveAs(id(1), { 3: 1000 })
let saved = await event()
assert.equal(saved.attendee_capacity, 1000)
assert.equal(saved.published_at, null)
await assert.rejects(saveAs(id(1), { 4: true }), /approved venue/)
await db.query(`update public.venue_bookings set status='APPROVED' where booking_id=$1`, [id(42)])
// Every session's venue is approved: Hall 200 + Room 80. The cancelled Room booking does not count.
await assert.rejects(saveAs(id(1), { 3: 281 }), /combined venue capacity/)
await saveAs(id(1), { 3: 280 })
assert.equal((await event()).attendee_capacity, 280)
await assert.rejects(saveAs(id(1), { 4: true }), /equipment request/)
await db.query(`update public.equipment_requests set status='Approved' where id=$1`, [id(51)])
await assert.rejects(saveAs(id(1), { 4: true }), /Safety Officer/)
await db.query(`update public.events set status='confirmed' where id=$1`, [id(21)])
await assert.rejects(saveAs(id(1), { 4: true }), /Safety Officer/) // No review yet.
await db.query(`insert into public.event_safety_reviews(event_id,decision,created_at) values ($1,'APPROVED',now())`, [id(21)])
await saveAs(id(1), { 4: true })
const publishedAt = (await event()).published_at
assert.ok(publishedAt)
await saveAs(id(1), { 4: true })
assert.deepEqual((await event()).published_at, publishedAt) // Publishing again keeps the first time.
await saveAs(id(1))
assert.deepEqual((await event()).published_at, publishedAt) // A plain save never unpublishes.

// The latest safety decision counts, and an affected venue blocks again.
await db.query(`insert into public.event_safety_reviews(event_id,decision,created_at) values ($1,'CHANGES_REQUESTED',now()+interval '1 minute')`, [id(21)])
await assert.rejects(saveAs(id(1), { 4: true }), /Safety Officer/)
await db.query(`update public.venue_bookings set status='AFFECTED_BY_UNAVAILABILITY' where booking_id=$1`, [id(42)])
await assert.rejects(saveAs(id(1), { 4: true }), /approved venue/)

// No edits once registration has closed.
await db.query(`update public.events set registration_opens_at=now()-interval '2 days',registration_closes_at=now()-interval '1 hour' where id=$1`, [id(21)])
await assert.rejects(saveAs(id(1)), /already closed/)

// Arrangements: the owner sees live venues and equipment; nobody else sees any.
const arrangements = 'select * from public.list_event_arrangements($1) order by kind, session_id'
const rows = await asUser('authenticated', id(1), arrangements, [id(21)])
assert.deepEqual(rows.map(row => [row.kind, row.session_id, row.status]), [
  ['equipment', id(31), 'Approved'],
  ['venue', id(31), 'APPROVED'],
  ['venue', id(32), 'AFFECTED_BY_UNAVAILABILITY'],
])
assert.equal(rows[1].venue_name, 'Hall')
assert.equal(rows[1].venue_location, 'Campus West')
assert.equal(rows[1].venue_capacity, 200)
assert.deepEqual(await asUser('authenticated', id(2), arrangements, [id(21)]), [])
await assert.rejects(asUser('anon', '', arrangements, [id(21)]))
