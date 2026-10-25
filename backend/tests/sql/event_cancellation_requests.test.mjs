// Isolated PostgreSQL integration: no connection to Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const sql = file => readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8')

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table public.profiles(id uuid primary key, role text);
create function public.is_organiser() returns boolean language sql stable as $$select exists(select 1 from public.profiles where id=auth.uid() and role='organiser')$$;
create table public.events(
  id uuid primary key,
  organiser_id uuid,
  status text constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check', 'cancellation_requested', 'cancelled'
  )),
  updated_at timestamptz default now()
);
insert into public.profiles values
  ('${id(1)}','organiser'), ('${id(2)}','organiser'), ('${id(3)}','coordinator');
insert into public.events values
  ('${id(11)}','${id(1)}','under_review'),
  ('${id(12)}','${id(1)}','planning'),
  ('${id(13)}','${id(1)}','awaiting_safety_check'),
  ('${id(14)}','${id(1)}','confirmed'),
  ('${id(15)}','${id(1)}','awaiting_clarification'),
  ('${id(16)}','${id(1)}','change_requested'),
  ('${id(17)}','${id(1)}','completed'),
  ('${id(18)}','${id(1)}','rejected'),
  ('${id(19)}','${id(1)}','cancelled');
grant select on public.profiles, public.events to authenticated;
`)
await db.exec(await sql('event_cancellation_requests.sql'))
await db.exec(await sql('event_cancellation_request_statuses.sql'))
await db.exec(await sql('event_cancellation_request_status_transition.sql'))

async function asUser(user, query, params = []) {
  await db.exec('set role authenticated')
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user])
  try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
}
const submit = 'select public.submit_event_cancellation_request($1,$2)'
const submitAs = (user, eventId, reason = 'Plans have changed') =>
  asUser(user, submit, [eventId, reason])

await assert.rejects(asUser('', submit, [id(11), 'Plans changed']))
await assert.rejects(submitAs(id(3), id(11)), /signed-in organiser/)
await assert.rejects(submitAs(id(2), id(11)), /not found/)

for (const eventId of [id(12), id(13), id(14), id(15), id(16)]) {
  await submitAs(id(1), eventId)
  await assert.rejects(submitAs(id(1), eventId), /pending cancellation request/)
}
for (const eventId of [id(11), id(17), id(18), id(19)]) {
  await assert.rejects(submitAs(id(1), eventId), /current status/)
}

const ownRequests = await asUser(
  id(1),
  'select event_id, reason, previous_event_status, status from public.event_cancellation_requests order by event_id',
)
assert.deepEqual(ownRequests, [
  { event_id: id(12), reason: 'Plans have changed', previous_event_status: 'planning', status: 'pending' },
  { event_id: id(13), reason: 'Plans have changed', previous_event_status: 'awaiting_safety_check', status: 'pending' },
  { event_id: id(14), reason: 'Plans have changed', previous_event_status: 'confirmed', status: 'pending' },
  { event_id: id(15), reason: 'Plans have changed', previous_event_status: 'awaiting_clarification', status: 'pending' },
  { event_id: id(16), reason: 'Plans have changed', previous_event_status: 'change_requested', status: 'pending' },
])
assert.deepEqual(
  await asUser(id(2), 'select * from public.event_cancellation_requests'),
  [],
)
await assert.rejects(
  asUser(id(1), `insert into public.event_cancellation_requests(event_id,organiser_id,reason)
    values ($1,$2,$3)`, [id(11), id(1), 'Direct write']),
)
const statuses = await db.query('select status from public.events order by id')
assert.deepEqual(statuses.rows.map(row => row.status), [
  'under_review', 'cancellation_requested', 'cancellation_requested',
  'cancellation_requested', 'cancellation_requested',
  'cancellation_requested', 'completed', 'rejected', 'cancelled',
])

await db.close()

// Verify the additive migration upgrades a database with the old table shape
// and backfills the previous status of existing requests.
const legacyDb = new PGlite()
await legacyDb.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table public.profiles(id uuid primary key, role text);
create function public.is_organiser() returns boolean language sql stable as $$select exists(select 1 from public.profiles where id=auth.uid() and role='organiser')$$;
create table public.events(
  id uuid primary key,
  organiser_id uuid,
  status text constraint events_status_valid check (status in (
    'draft', 'under_review', 'rejected', 'planning', 'confirmed',
    'completed', 'change_requested', 'awaiting_clarification',
    'awaiting_safety_check'
  )),
  updated_at timestamptz default now()
);
create table public.event_cancellation_requests(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  organiser_id uuid not null references public.profiles(id),
  reason text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
insert into public.profiles values ('${id(1)}','organiser');
insert into public.events values
  ('${id(21)}','${id(1)}','planning',now()),
  ('${id(22)}','${id(1)}','confirmed',now());
insert into public.event_cancellation_requests
  values ('${id(31)}','${id(21)}','${id(1)}','Legacy request','pending',now());
`)
await legacyDb.exec(await sql('event_cancellation_request_status_transition.sql'))
const legacyRows = await legacyDb.query(
  'select previous_event_status from public.event_cancellation_requests where id=$1',
  [id(31)],
)
assert.deepEqual(legacyRows.rows, [{ previous_event_status: 'planning' }])
await legacyDb.exec('set role authenticated')
await legacyDb.query(
  `select set_config('request.jwt.claim.sub',$1,false)`,
  [id(1)],
)
await legacyDb.query(
  'select public.submit_event_cancellation_request($1,$2)',
  [id(22), 'New cancellation request'],
)
await legacyDb.exec('reset role')
const upgradedEvent = await legacyDb.query(
  'select status from public.events where id=$1',
  [id(22)],
)
assert.deepEqual(upgradedEvent.rows, [{ status: 'cancellation_requested' }])
await legacyDb.close()
