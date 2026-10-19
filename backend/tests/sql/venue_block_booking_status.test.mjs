// Isolated PostgreSQL checks; never connects to Supabase.
// Provide @electric-sql/pglite or set IMPACT_TEST_PGLITE_MODULE to its module URL.
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
create table public.profiles(id uuid primary key,role text);
create table public.venues(id uuid primary key,name text,setup_time_minutes int,turnaround_time_minutes int);
create table public.events(id uuid primary key,name text,coordinator_id uuid);
create table public.venue_blocks(block_id uuid primary key,venue_id uuid,start_at timestamptz,end_at timestamptz);
create function public.is_venue_staff() returns boolean language sql stable security invoker as $$select exists(select 1 from public.profiles where id=auth.uid() and role='venue_staff')$$;
insert into public.profiles values ('${id(1)}','venue_staff'),('${id(2)}','coordinator'),('${id(3)}','coordinator');
insert into public.venues values ('${id(11)}','Hall',30,45),('${id(12)}','Other',0,0);
insert into public.events values ('${id(21)}','Workshop','${id(3)}');
insert into public.venue_blocks values ('${id(41)}','${id(11)}','2099-11-07T09:15+08:00','2099-11-07T09:45+08:00');
`)
await db.exec(await sql('venue_bookings.sql'))
await db.exec(`
grant select on public.profiles,public.venues,public.events to authenticated;
grant select,update on public.venue_bookings to authenticated;
insert into public.venue_bookings(booking_id,venue_id,coordinator_id,event_id,room_layout,start_at,end_at,effective_start_at,effective_end_at,status)
select ('00000000-0000-0000-0000-'||lpad((30+i)::text,12,'0'))::uuid,
 case when i=6 then '${id(12)}'::uuid else '${id(11)}'::uuid end,'${id(2)}','${id(21)}','Theatre',
 '2099-11-07T10:00+08:00','2099-11-07T12:00+08:00','2099-11-07T10:00+08:00','2099-11-07T12:00+08:00',
 case i when 3 then 'PENDING_VENUE_APPROVAL' when 4 then 'REJECTED' when 5 then 'CANCELLED' else 'APPROVED' end
from generate_series(1,6) i;
`)
const source = await sql('venue_block_booking_status.sql')
await db.exec(source)
await db.exec(source)
await db.exec(await sql('venue_block_booking_reads.sql'))
const snapshot = () => db.query('select to_jsonb(b) as value from public.venue_bookings b order by booking_id')
const before = await snapshot()
async function asUser(role, user, query, params) {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user])
  try { return await db.query(query, params) } finally { await db.exec('reset role') }
}
const statement = 'select public.mark_venue_block_bookings_affected($1::uuid,$2::uuid[]) as data'
for (const [role,user] of [['anon',''],['authenticated',''],['authenticated',id(2)]]) {
  await assert.rejects(asUser(role,user,statement,[id(11),[id(31)]]))
}
assert.deepEqual(await snapshot(), before)

// A row-level failure rolls back the entire batch, but not the previously saved block.
await db.exec(`create function public.reject_test_update() returns trigger language plpgsql as $$begin if new.booking_id='${id(32)}' then raise exception 'test failure'; end if; return new; end;$$;
create trigger reject_test_update before update on public.venue_bookings for each row execute function public.reject_test_update();`)
await assert.rejects(asUser('authenticated',id(1),statement,[id(11),[id(31),id(32)]]), /test failure/)
assert.deepEqual(await snapshot(), before)
assert.equal((await db.query('select count(*)::int as n from public.venue_blocks')).rows[0].n,1)
await db.exec('drop trigger reject_test_update on public.venue_bookings')

const changed = (await asUser('authenticated',id(1),statement,[id(11),[id(31),id(33),id(34),id(35),id(36)]])).rows[0].data
assert.deepEqual(changed,[{booking_id:id(31),status:'AFFECTED_BY_UNAVAILABILITY'}])
const after = await snapshot()
const expected = structuredClone(before)
expected.rows.find(r => r.value.booking_id===id(31)).value.status='AFFECTED_BY_UNAVAILABILITY'
assert.deepEqual(after,expected) // No times, buffers, reviewer, event link or other arrangement changed.
assert.deepEqual((await asUser('authenticated',id(1),statement,[id(11),[id(31)]])).rows[0].data,[])
const projected = (await asUser('authenticated',id(1),'select public.get_venue_block_bookings($1::uuid) as data',[id(11)])).rows[0].data
assert.deepEqual(projected.map(b=>b.booking_id),[id(32)])
assert.equal(projected[0].coordinator_id,id(3)) // Current assignee, not original submitter.
assert.equal((await db.query('select coordinator_id from public.events')).rows[0].coordinator_id,id(3))

// The RPC's scalar JSON result is complete even above the API's usual row limit.
await db.exec(`insert into public.venue_bookings(booking_id,venue_id,coordinator_id,room_layout,start_at,end_at,effective_start_at,effective_end_at,status)
select ('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'${id(11)}','${id(2)}','Theatre',now(),now()+interval '1 hour',now(),now()+interval '1 hour','APPROVED' from generate_series(1,1001) i`)
const identities = (await db.query("select booking_id from public.venue_bookings where booking_id::text like '10000000-%'")).rows.map(r=>r.booking_id)
assert.equal((await asUser('authenticated',id(1),statement,[id(11),identities])).rows[0].data.length,1001)
await db.close()
console.log('PASS: staff authorization, conditional atomic status update, failure rollback with block retained, untouched arrangements/times/events, repeated-call exclusion, current Coordinator and >1000 results.')
