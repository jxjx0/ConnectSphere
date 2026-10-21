// Isolated PostgreSQL integration: no connection to Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.IMPACT_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const sql = file => readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8')
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table public.profiles(id uuid primary key,role text);
create table public.venues(id uuid primary key,name text,setup_time_minutes int,turnaround_time_minutes int,operating_hours jsonb);
create table public.events(id uuid primary key,name text,coordinator_id uuid,status text,start_time timestamptz,end_time timestamptz);
create table public.venue_blocks(block_id uuid primary key default gen_random_uuid(),venue_id uuid,start_at timestamptz,end_at timestamptz,block_reason text,block_issuer uuid);
create function public.is_venue_staff() returns boolean language sql stable security invoker as $$select exists(select 1 from public.profiles where id=auth.uid() and role='venue_staff')$$;
insert into public.profiles values ('${id(1)}','venue_staff'),('${id(2)}','coordinator'),('${id(3)}','coordinator'),('${id(4)}','organiser');
insert into public.venues values ('${id(11)}','Hall',30,45,'{"open":"08:00","close":"22:00"}'),('${id(12)}','Other',0,0,'{"open":"08:00","close":"22:00"}');
insert into public.events select '${id(21)}','Workshop','${id(2)}','planning','2099-11-07T10:00+08:00','2099-11-07T12:00+08:00';
insert into public.events select '${id(22)}','Other event','${id(3)}','planning','2099-11-07T10:00+08:00','2099-11-07T12:00+08:00';
grant select on public.profiles,public.venues,public.events,public.venue_blocks to authenticated,service_role;
`)
await db.exec(await sql('venue_bookings.sql'))
await db.exec(await sql('venue_tentative_holds.sql'))
await db.exec(await sql('venue_tentative_holds.sql'))
await db.exec('grant select,insert,update on public.venue_bookings to authenticated')
async function asUser(role, user, query, params = []) {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user])
  try { return (await db.query(query, params)).rows } finally { await db.exec('reset role') }
}
const create = 'select public.create_venue_tentative_hold($1,$2,$3,$4,$5) as data'
const params = [id(11),id(21),'2099-11-07T10:00+08:00','2099-11-07T12:00+08:00','2099-11-06T12:00+08:00']
const reservations = 'select public.get_venue_reservations($1::uuid[],$2::uuid,$3::boolean) as data'
for (const [role,user] of [['anon',''],['authenticated',''],['authenticated',id(2)],['authenticated',id(4)]]) {
  await assert.rejects(asUser(role,user,create,params))
}
for (const changes of [
  { 3: params[2] }, { 4: '2000-01-01T00:00Z' }, { 4: '2099-11-07T09:31+08:00' },
  { 1: id(99) }, { 0: id(99) }, { 2: '2099-11-07T08:00+08:00', 3: '2099-11-07T09:00+08:00' },
]) {
  const values = [...params]; Object.entries(changes).forEach(([key,value]) => { values[Number(key)] = value })
  await assert.rejects(asUser('authenticated',id(1),create,values))
}
const hold = (await asUser('authenticated',id(1),create,params))[0].data
assert.equal(hold.event_id,id(21))
assert.equal(hold.created_by,id(1))
const read = async (venue=id(11), exclude=null, only=false, user=id(2)) =>
  (await asUser('authenticated',user,reservations,[[venue],exclude,only]))[0].data
let rows = await read()
assert.equal(rows.length,1)
assert.equal(rows[0].type,'tentative_hold')
assert.equal(new Date(rows[0].start_at).toISOString(),'2099-11-07T01:30:00.000Z')
assert.equal(new Date(rows[0].end_at).toISOString(),'2099-11-07T04:45:00.000Z')
assert.equal(rows[0].reason,'Tentative hold') // No other event/Coordinator details leak.
await db.query('update public.venues set setup_time_minutes=null where id=$1',[id(11)])
await assert.rejects(read())
await db.query('update public.venues set setup_time_minutes=30 where id=$1',[id(11)])
await db.query('update public.venues set turnaround_time_minutes=60 where id=$1',[id(11)])
assert.equal(new Date((await read())[0].end_at).toISOString(),'2099-11-07T05:00:00.000Z')
await db.query('update public.venues set turnaround_time_minutes=45 where id=$1',[id(11)])
assert.deepEqual(await read(id(12)),[])
assert.deepEqual(await read(id(11),id(21),true),[])
await assert.rejects(read(id(11),id(21),true,id(3)))
await assert.rejects(asUser('authenticated',id(4),reservations,[[id(11)],null,false]))
await assert.rejects(asUser('authenticated',id(2),'select public.claim_expired_venue_holds()'))
await assert.rejects(asUser('authenticated',id(2),'insert into public.venue_tentative_holds(venue_id) values($1)',[id(11)]))
assert.equal((await asUser('authenticated',id(3),'select * from public.venue_tentative_holds')).length,0)

// Both holds are expanded: exact effective boundaries are allowed.
for (const [start,end,allowed] of [
  ['2099-11-07T08:00+08:00','2099-11-07T09:00+08:00',false],
  ['2099-11-07T13:00+08:00','2099-11-07T14:00+08:00',false],
  ['2099-11-07T13:15+08:00','2099-11-07T14:00+08:00',true],
]) {
  const attempt = [...params]; attempt[1]=id(22); attempt[2]=start; attempt[3]=end
  if (allowed) await asUser('authenticated',id(1),create,attempt)
  else await assert.rejects(asUser('authenticated',id(1),create,attempt))
}
// Another venue remains independent for the same event.
await asUser('authenticated',id(1),create,[id(12),...params.slice(1)])
await db.exec(`insert into public.venue_blocks(venue_id,start_at,end_at,block_reason)
values('${id(12)}','2099-11-08T10:00+08:00','2099-11-08T12:00+08:00','Maintenance')`)
await assert.rejects(asUser('authenticated',id(1),create,[id(12),id(21),'2099-11-08T10:30+08:00','2099-11-08T11:00+08:00',params[4]]))

// Partial approval does not release the full hold; full matching approval does.
const insertBooking = `insert into public.venue_bookings(booking_id,venue_id,event_id,coordinator_id,room_layout,start_at,end_at,effective_start_at,effective_end_at,status)
 values($1,$2,$3,'${id(2)}','Classroom',$4,$5,$4,$5,$6)`
await db.query(insertBooking,[id(31),id(11),id(21),params[2],'2099-11-07T11:00+08:00','APPROVED'])
assert.equal((await read()).filter(r=>r.id===hold.hold_id).length,1)
await db.query(insertBooking,[id(32),id(11),id(21),params[2],params[3],'PENDING_VENUE_APPROVAL'])
assert.equal((await read()).filter(r=>r.id===hold.hold_id).length,1)
await db.query('update public.venue_bookings set status=$1 where booking_id=$2',['APPROVED',id(32)])
assert.equal((await read()).filter(r=>r.id===hold.hold_id).length,0)
assert.equal((await read()).filter(r=>r.type==='confirmed_booking').length,2)
await assert.rejects(asUser('authenticated',id(1),create,[id(11),id(22),...params.slice(2)]))
assert.equal((await read(id(12))).filter(r=>r.type==='tentative_hold').length,1)
assert.equal((await db.query('select status from public.events where id=$1',[id(21)])).rows[0].status,'planning')
assert.equal((await db.query('select completed_booking_id from public.venue_tentative_holds where hold_id=$1',[hold.hold_id])).rows[0].completed_booking_id,id(32))

// Expiry is query-time (including the exact boundary), and the runner is leased.
await db.exec('begin')
await db.query('update public.events set coordinator_id=$1 where id=$2',[id(3),id(21)])
await db.query(`update public.venue_tentative_holds set created_at=now()-interval '2 hours',expires_at=now()
 where venue_id=$1`,[id(12)])
assert.deepEqual(await read(id(12)),[])
let claims = (await asUser('service_role','', 'select public.claim_expired_venue_holds() as data'))[0].data
assert.equal(claims.length,1)
assert.equal(claims[0].coordinator_id,id(3))
assert.deepEqual((await asUser('service_role','', 'select public.claim_expired_venue_holds() as data'))[0].data,[])
const oldClaim = claims[0].expiry_claimed_at
await db.query("update public.venue_tentative_holds set expiry_claimed_at=now()-interval '6 minutes' where hold_id=$1",[claims[0].hold_id])
claims = (await asUser('service_role','', 'select public.claim_expired_venue_holds() as data'))[0].data
assert.equal(claims.length,1)
await asUser('service_role','', 'select public.acknowledge_venue_hold_expiry($1,$2)',[claims[0].hold_id,oldClaim])
assert.equal((await db.query('select expiry_notified_at from public.venue_tentative_holds where hold_id=$1',[claims[0].hold_id])).rows[0].expiry_notified_at,null)
await asUser('service_role','', 'select public.acknowledge_venue_hold_expiry($1,$2)',[claims[0].hold_id,claims[0].expiry_claimed_at])
await db.exec('commit')
assert.deepEqual((await asUser('service_role','', 'select public.claim_expired_venue_holds() as data'))[0].data,[])
await asUser('authenticated',id(1),create,[id(12),...params.slice(1)])
assert.equal((await read(id(12))).length,1)
assert.equal((await db.query('select count(*)::int as n from public.venue_tentative_holds where venue_id=$1',[id(12)])).rows[0].n,2)

// Zero-buffer legacy snapshots still reserve the authoritative setup/turnaround.
const confirmed = (await read()).find(r=>r.id===id(32))
assert.equal(new Date(confirmed.start_at).toISOString(),'2099-11-07T01:30:00.000Z')
assert.equal(new Date(confirmed.end_at).toISOString(),'2099-11-07T04:45:00.000Z')
assert.equal(new Date(confirmed.event_start_at).toISOString(),'2099-11-07T02:00:00.000Z')
await db.query('update public.venue_bookings set effective_start_at=$1,effective_end_at=$2 where booking_id=$3',
 ['2099-11-07T09:00+08:00','2099-11-07T13:00+08:00',id(32)])
assert.equal(new Date((await read()).find(r=>r.id===id(32)).start_at).toISOString(),'2099-11-07T01:00:00.000Z')

// Legacy grouping requires the complete fingerprint and a unique booking.
await db.query('update public.venue_bookings set reviewed_by=$1 where booking_id=$2',[id(1),id(32)])
await db.exec(`insert into public.venue_blocks(block_id,venue_id,start_at,end_at,block_reason,block_issuer)
 values('${id(71)}','${id(11)}','2099-11-07T09:00+08:00','2099-11-07T13:00+08:00','Approved Booking: Workshop (Classroom)','${id(1)}'),
 ('${id(72)}','${id(11)}','2099-11-07T09:00+08:00','2099-11-07T13:00+08:00','Maintenance','${id(1)}')`)
assert.deepEqual((await read()).find(r=>r.id===id(32)).legacy_blocks.map(b=>b.id),[id(71)])
await db.query(insertBooking,[id(33),id(11),id(21),'2099-11-07T09:00+08:00','2099-11-07T13:00+08:00','APPROVED'])
await db.query('update public.venue_bookings set reviewed_by=$1 where booking_id=$2',[id(1),id(33)])
assert.deepEqual((await read()).find(r=>r.id===id(32)).legacy_blocks,[])

// Complete aggregate reads include more than the usual Data API row cap.
await db.exec(`insert into public.venue_blocks(venue_id,start_at,end_at,block_reason)
 select '${id(12)}','2099-12-01T10:00+08:00','2099-12-01T11:00+08:00','Test block '||n from generate_series(1,1005) n`)
const blocksQuery='select public.get_venue_operational_blocks($1::uuid[],$2,$3) as data'
const blockParams=[[id(12)],'2099-12-01T10:00+08:00','2099-12-01T11:00+08:00']
assert.equal((await asUser('authenticated',id(2),blocksQuery,blockParams))[0].data.length,1005)
assert.deepEqual((await asUser('authenticated',id(2),blocksQuery,[[id(12)],'2099-12-01T11:00+08:00','2099-12-01T12:00+08:00']))[0].data,[])
await assert.rejects(asUser('authenticated',id(4),blocksQuery,blockParams))
await assert.rejects(asUser('anon','',blocksQuery,blockParams))

// Approval after expiry must not remove the queued expiry notification.
const late = (await read(id(12))).find(r=>r.type==='tentative_hold')
await db.query(`update public.venue_tentative_holds set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where hold_id=$1`,[late.id])
await db.query(insertBooking,[id(90),id(12),id(21),params[2],params[3],'APPROVED'])
assert.equal((await db.query('select completed_booking_id from public.venue_tentative_holds where hold_id=$1',[late.id])).rows[0].completed_booking_id,id(90))
claims=(await asUser('service_role','','select public.claim_expired_venue_holds() as data'))[0].data
assert.equal(claims.length,1)
assert.equal(claims[0].hold_id,late.id)
assert.equal(claims[0].completed_booking_id,id(90))
await asUser('service_role','','select public.acknowledge_venue_hold_expiry($1,$2)',[late.id,claims[0].expiry_claimed_at])
assert.deepEqual((await asUser('service_role','','select public.claim_expired_venue_holds() as data'))[0].data,[])
assert.equal((await db.query('select count(*)::int as n from public.venue_blocks where block_id=any($1)',[[id(71),id(72)]])).rows[0].n,2)
await db.close()
console.log('PASS: hold validation/auth/RLS, effective boundaries, active/expired, independent venues, confirmation release and expiry notification leases.')
