// Isolated PostgreSQL integration: no connection to shared Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const sql = file => readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8')

try {
  await db.exec(`
    create role anon; create role authenticated; create role authenticator;
    create role migration_owner nologin createrole;
    grant authenticated to migration_owner with admin option;
    grant create on schema public to migration_owner;
    create schema venue_private authorization migration_owner;
    alter default privileges for role migration_owner in schema venue_private
      grant select on tables to authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table public.profiles(id uuid primary key, role text);
    create table public.venues(id uuid primary key);
    create table public.events(id uuid primary key, name text, private_details text);
    create table public.event_sessions(
      id uuid primary key, event_id uuid not null references public.events(id), name text, private_details text
    );
    alter table public.events enable row level security;
    alter table public.event_sessions enable row level security;
    create policy visible_event_sessions on public.event_sessions for select to authenticated
      using (exists(select 1 from public.events e where e.id=event_id));
    grant select on public.events, public.event_sessions, public.profiles to authenticated;
    create function public.is_venue_staff() returns boolean language sql stable
      security definer set search_path='' as $$
        select exists(select 1 from public.profiles where id=auth.uid() and role='venue_staff')
      $$;
    revoke all on function public.is_venue_staff() from public;
    grant execute on function public.is_venue_staff() to authenticated;
    insert into public.profiles values
      ('${id(1)}','venue_staff'),('${id(2)}','coordinator'),('${id(3)}','organiser'),
      ('${id(4)}','attendee'),('${id(5)}','tech_support'),
      ('${id(6)}','event_coordinator_lead'),('${id(7)}','safety_officer'),('${id(8)}','venue_staff');
    insert into public.venues values ('${id(10)}');
    insert into public.events values
      ('${id(20)}','Actual event name','Secret organiser details'),
      ('${id(21)}','Unrelated private event','Secret'),
      ('${id(22)}','Approved booking event','Secret');
    insert into public.event_sessions values
      ('${id(50)}','${id(20)}','Opening session','Private session details'),
      ('${id(51)}','${id(21)}','Unrelated session','Private'),
      ('${id(52)}','${id(20)}',null,'Draft session');
  `)
  await db.exec(await sql('venue_bookings.sql'))
  await db.exec(`
    alter table public.venue_bookings add foreign key(event_id) references public.events(id);
    alter table public.venue_bookings add column session_id uuid references public.event_sessions(id);
    grant select on public.venue_bookings to authenticated;
    insert into public.venue_bookings
      (booking_id,venue_id,coordinator_id,event_id,session_id,room_layout,start_at,end_at,effective_start_at,effective_end_at,status)
    values
      ('${id(30)}','${id(10)}','${id(2)}','${id(20)}','${id(50)}','Theatre',now(),now(),now(),now(),'PENDING_VENUE_APPROVAL'),
      ('${id(31)}','${id(10)}','${id(2)}','${id(22)}',null,'Theatre',now(),now(),now(),now(),'APPROVED'),
      ('${id(32)}','${id(10)}','${id(2)}',null,null,'Theatre',now(),now(),now(),now(),'PENDING_VENUE_APPROVAL'),
      ('${id(33)}','${id(10)}','${id(2)}','${id(20)}','${id(51)}','Theatre',now(),now(),now(),now(),'PENDING_VENUE_APPROVAL'),
      ('${id(34)}','${id(10)}','${id(2)}','${id(20)}','${id(52)}','Theatre',now(),now(),now(),now(),'PENDING_VENUE_APPROVAL'),
      ('${id(35)}','${id(10)}','${id(2)}','${id(20)}',null,'Theatre',now(),now(),now(),now(),'PENDING_VENUE_APPROVAL');
  `)
  // Use a non-superuser installer that owns the source tables, like Supabase's
  // trusted database owner. Verify role grants/ownership transfer work there.
  for (const table of ['profiles','venues','venue_bookings','events','event_sessions']) {
    await db.exec(`alter table public.${table} owner to migration_owner`)
  }
  const tables = 'select * from public.venue_bookings order by booking_id'
  const originalBookings = (await db.query(tables)).rows
  const policies = "select schemaname,tablename,policyname,qual,with_check from pg_policies order by schemaname,tablename,policyname"
  const originalPolicies = (await db.query(policies)).rows
  const migration = await sql('venue_booking_request_names.sql')
  await db.exec('set role migration_owner')
  try {
    await db.exec(migration)
    await db.exec(migration) // Repeatable without changing booking/event policies.
  } catch (error) {
    await db.exec('rollback')
    throw error
  } finally { await db.exec('reset role') }
  assert.deepEqual((await db.query(tables)).rows, originalBookings)
  assert.deepEqual((await db.query(policies)).rows, originalPolicies)

  async function asUser(role, user, query, params = []) {
    await db.exec(`set role ${role}`)
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
    try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
  }
  const lookup = 'select * from public.get_venue_booking_event_names($1::uuid[]) order by booking_id'
  const privateLookup = 'select * from venue_private.get_venue_booking_event_names($1::uuid[]) order by booking_id'
  const expected = [
    { booking_id: id(30), event_name: 'Actual event name', session_name: 'Opening session' },
    { booking_id: id(33), event_name: 'Actual event name', session_name: null }, // Mismatched event/session.
    { booking_id: id(34), event_name: 'Actual event name', session_name: null }, // Unnamed session.
    { booking_id: id(35), event_name: 'Actual event name', session_name: null }, // Legacy booking.
  ]
  const requested = [[id(30),id(30),id(31),id(32),id(33),id(34),id(35),id(99),id(21)]]
  assert.deepEqual(await asUser('authenticated', id(1), 'select * from public.events'), [])
  assert.deepEqual(await asUser('authenticated', id(1), 'select * from public.event_sessions'), [])
  assert.deepEqual(await asUser('authenticated', id(1), lookup, requested), expected)
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, requested), expected)
  assert.deepEqual(await asUser('authenticated', id(1), lookup, [[]]), [])
  assert.deepEqual(await asUser('authenticated', id(1), lookup, [null]), [])
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, [[]]), [])
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, [null]), [])
  // The private view is not another route around booking RLS. Application
  // roles cannot SELECT it or assume the non-login function-owner role.
  for (const user of [1,2,3,4,5,6,7,8,99]) {
    await assert.rejects(asUser('authenticated', id(user),
      'select * from venue_private.venue_booking_name_projection'))
  }
  assert.equal((await db.query("select pg_has_role('authenticated','venue_booking_name_reader','MEMBER') as member")).rows[0].member, false)
  for (const role of ['anon','authenticated','authenticator']) {
    assert.equal((await db.query("select pg_has_role($1,'venue_booking_name_reader','MEMBER') as member", [role])).rows[0].member, false)
  }
  assert.deepEqual((await db.query(`select rolcanlogin,rolsuper,rolbypassrls
    from pg_roles where rolname='venue_booking_name_reader'`)).rows,
    [{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }])
  for (const [role,user] of [['anon',''],['authenticated',''],
    ...[2,3,4,5,6,7,99].map(n => ['authenticated',id(n)])]) {
    await assert.rejects(asUser(role,user,lookup,requested))
    await assert.rejects(asUser(role,user,privateLookup,requested))
  }
  // Renames are read live; names are never duplicated/stored on a booking.
  await db.query('update public.events set name=$1 where id=$2', ['Renamed event',id(20)])
  await db.query('update public.event_sessions set name=$1 where id=$2', ['Renamed session',id(50)])
  assert.deepEqual(await asUser('authenticated', id(1), lookup, requested),
    expected.map(row => ({ ...row, event_name: 'Renamed event',
      session_name: row.session_name ? 'Renamed session' : null })))

  // A private call must obey booking RLS too, with the original caller's UID.
  // Staff member 8 can read booking 30; staff member 1 cannot.
  await db.exec(`create policy restricted_booking_read on public.venue_bookings
    as restrictive for select to authenticated
    using (booking_id <> '${id(30)}' or auth.uid()='${id(8)}')`)
  assert.deepEqual(await asUser('authenticated', id(1), lookup, [[id(30)]]), [])
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, [[id(30)]]), [])
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, requested),
    expected.filter(row => row.booking_id !== id(30)).map(row => ({ ...row, event_name: 'Renamed event' })))
  assert.deepEqual(await asUser('authenticated', id(8), privateLookup, [[id(30)]]),
    [{ booking_id: id(30), event_name: 'Renamed event', session_name: 'Renamed session' }])
  // Caller-supplied row_security=off cannot defeat the helper's SET clause.
  await db.exec('set row_security=off')
  try { assert.deepEqual(await asUser('authenticated', id(1), privateLookup, [[id(30)]]), []) }
  finally { await db.exec('set row_security=on') }
  // Both routes fail closed if booking RLS is disabled or the helper owner
  // accidentally becomes a table owner / BYPASSRLS role.
  await db.exec('alter table public.venue_bookings disable row level security')
  for (const query of [lookup,privateLookup]) {
    await assert.rejects(asUser('authenticated',id(1),query,requested), /Booking row security must be active/)
  }
  await db.exec('alter table public.venue_bookings enable row level security')
  await db.exec('alter function venue_private.get_venue_booking_event_names(uuid[]) owner to migration_owner')
  await assert.rejects(asUser('authenticated',id(1),privateLookup,requested), /Booking row security must be active/)
  await db.exec('grant create on schema venue_private to venue_booking_name_reader')
  await db.exec('alter function venue_private.get_venue_booking_event_names(uuid[]) owner to venue_booking_name_reader')
  await db.exec('revoke create on schema venue_private from venue_booking_name_reader')
  assert.deepEqual(await asUser('authenticated', id(1), 'select * from public.events'), [])
  // A completed booking no longer grants a name lookup.
  await db.exec('drop policy restricted_booking_read on public.venue_bookings')
  await db.query("update public.venue_bookings set status='REJECTED' where booking_id=$1", [id(30)])
  assert.deepEqual(await asUser('authenticated', id(1), lookup, [[id(30)]]), [])
  assert.deepEqual(await asUser('authenticated', id(1), privateLookup, [[id(30)]]), [])
  // Role removal is honored immediately, even with the same user identity.
  await db.query("update public.profiles set role='coordinator' where id=$1", [id(1)])
  await assert.rejects(asUser('authenticated', id(1), lookup, requested))
  await assert.rejects(asUser('authenticated', id(1), privateLookup, requested))
  console.log('Venue booking event/session-name access checks passed (isolated local PostgreSQL).')
} catch (error) {
  console.error(error.stack)
  console.error(error.code || '', error.where || '', error.detail || '')
  console.error('Query:', error.query?.slice(0, 240))
  process.exitCode = 1
} finally {
  await db.close()
}
