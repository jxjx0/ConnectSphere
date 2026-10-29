# Database scheduling

Use Supabase Cron for recurring database maintenance. It runs inside Postgres,
independently of Flask, browsers and developer computers. Keep scheduling setup
separate from ordinary schema scripts so a database update does not silently
enable background work.

## Completion job

The completion job invokes the existing public.complete_ended_events() function
every minute, using the schedule `* * * * *`. It completes events whose accepted
final session has ended (`events.end_time < now()`) when they are:

- `confirmed`;
- `change_requested`, with a pending change whose `event_status_before_request`
  is `confirmed`;
- `cancellation_requested`, with a pending cancellation whose
  `previous_event_status` is `confirmed`;
- `cancellation_requested`, with a pending cancellation whose previous status is
  `change_requested`, and a still-pending change whose previous status is `confirmed`.

The last case matters: cancellation submission preserves the literal current
event status. Do not overwrite that with `confirmed`; cancellation rejection
needs to restore `change_requested` so the change can still be reviewed.
Only pending rows establish eligibility. Approved/rejected/expired history must
never establish a prior confirmed state. Proposed future session dates are not
accepted dates and do not postpone completion.

Completion and expiry of **both** types of pending request happen in one database
transaction. Historical request rows, proposal details, `reviewed_at`, and
rejection reasons are preserved. `completed_at` is set once and preserved by
later checks; existing completed rows are not backfilled. At the exact end-time
boundary the event remains unchanged until a later check.

The same script installs insert guards on both request tables. A new pending
request locks its parent event and fails if that event is completed, including
when insertion waited for a concurrent completion to commit. Existing submission
RPCs keep their own authorization and status checks. These guards also cover the
session submission RPC without replacing its implementation. Inserting historical
approved/rejected/expired rows is unaffected; no existing request is rewritten.

The job is owned by the postgres database role. Its command starts a transaction
and assumes the existing service_role database role, which already has the
completion permissions. This is a database role switch, not an API call: no
password, service-role API key, HTTP endpoint or frontend configuration is added.
The function remains SECURITY INVOKER and unavailable to anon/authenticated.

The setup checks the execution role's function and column permissions and that
RLS will not silently hide events or requests. It does not broaden user policies.
The named job is updated in place; rerunning setup preserves its active/paused
state. A newly installed job is inactive until explicitly activated.

## Setup and deployment

These are deployment instructions for an authorised operator. Nothing in the
repository automatically runs them. Obtain approval before changing the shared
database, deploying a job, or activating one.

ConnectSphere uses **one shared Supabase project**. No separate staging project
is required. Obtain team approval before shared database writes, controlled test
record creation, or scheduler activation/pause.

Read-only verification on **30 October 2026 at 05:07 Singapore time** confirmed
pg_cron 1.6.4, the completion function/request guard, and both validated
request-status constraints allowing `expired`. Job 1,
`connectsphere-complete-ended-events`, was **active** with schedule `* * * * *`,
owned by postgres in database postgres. Its history contained **27 successful
runs and zero failures**, with the latest recorded start at 05:07 Singapore time.

The controlled two-session event completed automatically at 04:31:00.032814,
after its final session ended at 04:30:35.879224. Later checks preserved its
completion timestamp. This verifies that controlled case, not all integrations.

These are dated observations. Recheck the current state before any operational
change. The T7-266 scripts are already installed on the shared project; do not
replay them or older base scripts as a routine prerequisite.

1. Open the shared ConnectSphere project in Supabase Dashboard -> SQL Editor ->
   New query. Use postgres and verify the project/database before proceeding:

   ```sql
   select current_user, current_database();
   select name, installed_version, default_version
   from pg_available_extensions where name = 'pg_cron';
   select to_regclass('cron.job'),
     to_regprocedure('cron.schedule(text,text,text)'),
     to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)');
   ```

2. Run the read-only impact query under Monitoring below and review affected
   events/pending requests with the workflow owners before any writes. Obtain
   approval for any update or operational pause. Inspect deployed constraints
   and review RPCs.
   Prerequisites are the existing events, event_drafts, event_sessions,
   event_change_requests, and event_cancellation_requests scripts, including the
   existing previous-status columns, role helpers and assigned-event read policies
   from event_change_review.sql. **Do not replay older base scripts** over
   a team's deployed schema or replace its session-change functions.
   Apply `database/event_request_expiry.sql` first, then the updated
   `database/event_completion.sql`. Neither script runs completion.

   The status upgrade replaces only the two named status checks, atomically,
   without rewriting data or the unique pending-request indexes. A 5-second
   DDL lock timeout makes busy installations fail for an explicit retry. The
   wider checks are enforced immediately, then validated outside the strong
   DDL-lock transaction. If validation fails, investigate and rerun the script;
   do not activate completion until both constraints are validated:

   ```sql
   select conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)
   from pg_constraint
   where conname in ('event_change_requests_status_valid',
                    'event_cancellation_requests_status_valid');
   select pg_get_functiondef('public.complete_ended_events()'::regprocedure);
   select tgrelid::regclass, tgname, tgenabled
   from pg_trigger
   where tgfoid = 'public.reject_completed_event_request()'::regprocedure
     and not tgisinternal;
   select has_function_privilege('anon', 'public.complete_ended_events()', 'EXECUTE'),
          has_function_privilege('authenticated', 'public.complete_ended_events()', 'EXECUTE'),
          has_function_privilege('service_role', 'public.complete_ended_events()', 'EXECUTE');
   ```

   Expect both checks to allow `expired` and be validated; execution privileges
   must be false, false, true respectively. Both request insert triggers must
   exist and be enabled (`tgenabled = 'O'`). Deploy the backend conflict message
   and frontend expiry displays before activating the job.
3. Enable pg_cron through Supabase Dashboard -> Integrations -> Cron if needed.
   Do not disable/reinstall an existing extension; it may contain other jobs.
4. Only for an approved installation/update, run database/event_completion_schedule.sql
   as postgres. A new connectsphere-complete-ended-events job starts inactive;
   reapplication preserves an existing job's active/paused state. Missing
   dependencies or execution permissions cause an error and roll back setup.
5. Inspect the configuration:

   ```sql
   select jobid, jobname, schedule, command, database, username, active
   from cron.job
   where jobname = 'connectsphere-complete-ended-events'
     and username = 'postgres';
   ```

   Expect one row, schedule `* * * * *`, the intended database, owner postgres,
   and the reviewed command that assumes service_role and calls the function.
   A new job must show active = false. Reinstallation preserves the prior state.
6. Only after activation approval, enable the reviewed job:

   ```sql
   select cron.alter_job(
     job_id := (
       select jobid from cron.job
       where jobname = 'connectsphere-complete-ended-events'
         and username = 'postgres' and database = current_database()
     ),
     active := true
   );
   ```

7. Use the controlled shared-project verification below. Do not activate a
   second job or use unrelated business events as test fixtures.

## Reliability and monitoring

Event row locks make repeated and overlapping invocations safe. Existing review
RPCs lock requests before events; submissions lock events first. Completion uses
`FOR UPDATE SKIP LOCKED` on the event and `NOWAIT` on pending requests. If a
review holds a request lock, the per-event subtransaction releases its locks and
defers the entire event without partial expiry. This prevents a deadlock without
changing teammates' review functions. Once locks are held, eligibility is checked
again against current rows. A review that commits first determines the resulting
status/dates; a completion that commits first makes subsequent pending-only
reviews fail. Busy events may take an extra tick.

pg_cron runs at most one instance of a given job at a time. Keep one completion
job for this operation.

The command sets a 45-second statement timeout and a 5-second lock timeout,
keeping failed runs from holding locks indefinitely or building a long queue.
An error rolls back the completion pass; a later tick checks all overdue
eligible events again. Events missed during database downtime are therefore
eligible on a later successful run, rather than depending on one exact tick.
This does not guarantee minute-by-minute execution while the database is paused,
unavailable or overloaded.

Check Supabase Cron's History view or query:

```sql
select r.jobid, r.status, r.return_message, r.start_time, r.end_time
from cron.job_run_details r
join cron.job j on j.jobid = r.jobid
where j.jobname = 'connectsphere-complete-ended-events'
  and j.username = 'postgres' and j.database = current_database()
order by r.start_time desc
limit 20;
```

Expect recent succeeded runs and investigate failed or missing runs. To check
whether work is overdue, run this read-only query as postgres:

```sql
select e.id, e.status, e.end_time,
       c.event_status_before_request, r.previous_event_status
from public.events e
left join public.event_change_requests c on c.event_id = e.id and c.status = 'pending'
left join public.event_cancellation_requests r on r.event_id = e.id and r.status = 'pending'
where e.end_time < now() and (
  e.status = 'confirmed'
  or (e.status = 'change_requested' and c.event_status_before_request = 'confirmed')
  or (e.status = 'cancellation_requested' and (
    r.previous_event_status = 'confirmed'
    or (r.previous_event_status = 'change_requested'
        and c.event_status_before_request = 'confirmed')
  ))
);
```

Job history is not automatically cleaned up. Include its retention in the
project's database maintenance policy; this setup installs no cleanup job.

## Review and registration integration

The inspected shared schema contains `approve_session_change_request`, legacy
`approve_event_change_request`, `reject_event_change_request`, and
`review_event_cancellation_request`. Their pending-only checks and event locks
reject expired requests. The backend maps the change-review conflict to HTTP 409;
the frontend offers change review only for a pending change on a change_requested
event. Actual session/cancellation-review integration checks remain outstanding.
Cancellation review is not a prerequisite for completion to expire pending
cancellations; T7-266 does not implement that separate review workflow.

The session-change table/RPC definitions are deployed but absent from this
checkout's SQL scripts. Coordinate their reproducible migration and integration
verification with the owner; do not replace them with legacy event-only functions.
The concurrency suite exercises the available legacy review RPCs and a
cancellation row lock, not the full session/cancellation-review integrations.

`save_event_registration` already rejects completed events before saving or
publishing settings. The shared schema also contains `register_for_event`, whose
locked confirmed-status check rejects registration after completion without
rewriting registration_closes_at. Compatibility was verified using the actual
[PR #50 SQL at commit 123ba8de](https://github.com/jxjx0/ConnectSphere/blob/123ba8de4ad04e73df3c772af017bf74cd48a673/database/attendee_registrations.sql),
including an intentionally open window, retained history and denied direct writes.
This branch does not copy the attendee implementation. Coordinate application
integration with Charmaine before claiming the attendee API/UI is verified.

Both request API models accept string statuses and compare pending flags
explicitly with `pending`. Change-expiry notices are generic because cancellation
approval can also expire a pending change.

## Pause or remove only this job

Run as postgres after the appropriate operational approval:

```sql
select cron.alter_job(
  job_id := (
    select jobid from cron.job
    where jobname = 'connectsphere-complete-ended-events'
      and username = 'postgres' and database = current_database()
  ),
  active := false
);
```

To remove its schedule, use:

```sql
select cron.unschedule('connectsphere-complete-ended-events');
```

Pausing/removing the job leaves event data, the completion function and every
other scheduled job intact.

For a failed release, pause this job first and use a forward fix. Do not narrow
the status constraints while expired rows exist, restore confirmed statuses, or
clear completion timestamps as a routine rollback. Existing reviewed/expired
history must remain unchanged. Agree any data repair with the workflow owners.

## Local verification

From the repository root, run:

```powershell
.venv/Scripts/python.exe -m pytest backend/tests -q
$sqlTests = @(Get-ChildItem -LiteralPath backend/tests/sql -Filter '*.test.mjs' | ForEach-Object { $_.FullName })
node --test --test-concurrency=2 @sqlTests
cd frontend
npm.cmd test
npm.cmd run build
```

Use an installed @electric-sql/pglite package, or set IMPACT_TEST_PGLITE_MODULE
to the file URL of its dist/index.js. This matches the existing SQL test setup.
PGlite suites use in-memory PostgreSQL; all SQL suites run locally and never
contact Supabase or read application database credentials.

The concurrency suite requires `embedded-postgres@18.4.0-beta.17`; install it in a
temporary tools directory, outside project dependencies, along with
`@electric-sql/pglite@0.5.13`. Set `COMPLETION_TEST_POSTGRES_MODULE` to the file URL
of embedded-postgres's `dist/index.js` if it is not on the module path. For example
in PowerShell (no database credentials are read):

```powershell
$testTools = Join-Path $env:TEMP 'connectsphere-t7-266-tools'
npm.cmd install --prefix $testTools --no-save --package-lock=false @electric-sql/pglite@0.5.13 embedded-postgres@18.4.0-beta.17
$env:IMPACT_TEST_PGLITE_MODULE = ([Uri](Join-Path $testTools 'node_modules/@electric-sql/pglite/dist/index.js')).AbsoluteUri
$env:COMPLETION_TEST_POSTGRES_MODULE = ([Uri](Join-Path $testTools 'node_modules/embedded-postgres/dist/index.js')).AbsoluteUri
```

Until PR #50 is integrated, export its reviewed `database/attendee_registrations.sql`
at the pinned commit into a temporary file, and set
`COMPLETION_TEST_REGISTRATION_SQL` to that file's absolute path. The integration
test executes that SQL directly. It otherwise uses the repository migration if
present, and explicitly skips if neither is available. A missing explicitly
configured file fails the test. A skipped dependency test is not AC5 verification.

It creates and stops a disposable PostgreSQL cluster bound to 127.0.0.1. Separate
connections test both review/completion orderings, a locked cancellation row,
overlapping runners, retry, and timestamp preservation. It observes actual lock
waits to ensure the requests overlap. It does not connect to a configured URL or
use the application's Supabase credentials. The test PostgreSQL major version
differs from the shared project's PostgreSQL 17. Live integration verification
uses the existing shared project only after team approval.

PGlite has no pg_cron background worker. Scheduler tests use an explicit fixture
for the documented cron APIs: they check installation, cadence, owner, permissions,
inactive defaults, reapplication, and execute the actual stored job command
against the real completion function. They do not prove a live worker fires on
the minute. Recorded shared Cron history and the controlled timed event provide
that worker evidence.

On Windows, the prior full SQL run passed all 55 tests with zero skips but
required cleanup of an orphan PostgreSQL I/O helper before the runner exited.
This is a local test teardown limitation. If it recurs, inspect the specific
test process; do not terminate unrelated database processes.

## Acceptance evidence

Numbering follows [T7-266](https://is212-g2t7.atlassian.net/browse/T7-266).
Automated checks and deployed database behaviour do not establish untested
application flows as complete.

| AC | Evidence | Remaining live verification |
| --- | --- | --- |
| AC1 | Scheduler tests, recorded minute ticks and automatic completion of the controlled event. | Controlled scheduler case verified. |
| AC2 | SQL eligibility, nested pending-chain, unconfirmed-origin and historical-request tests. | Full eligibility matrix with approved fixtures. |
| AC3 | Real session-sync trigger/boundary tests and controlled two-session Cron check. | Controlled case verified. |
| AC4 | Atomic expiry/history/rollback tests and legacy review concurrency tests. | Actual session/cancellation-review expiry and concurrency flows. |
| AC5 | Existing settings guard and exact PR #50 SQL compatibility tests. | Integrated attendee API/UI and concurrent registration checks. |
| AC6 | Timestamp serialization/SQL tests and recorded completion timestamp. | Controlled case verified. |
| AC7 | Real RLS access tests and both detail-component tests. | Both roles in the browser. |
| AC8 | History/list-component tests and attendee SQL history check. | Integrated history/active views in the browser. |
| AC9 | Repeated/overlapping runner tests and later Cron checks preserving completed_at. | Controlled case verified. |
| AC10 | Submission/table guards, waiting-insert tests and hidden-action tests. | Actual session submission/API integration. |

## Remaining controlled verification in the shared project

Obtain team approval for dedicated records and any session-time adjustments.
Record their exact IDs and before/after event/request JSON. Do not replay the
general seed or modify unrelated events. Inspect all eligible events before any
approved activation: completion is project-wide, not scoped to test IDs.

1. Use dedicated events for a pending change from confirmed, direct cancellation
   from confirmed, and cancellation over a pending change from confirmed. After
   final accepted end, verify completion and expiry of both pending request types.
2. Compare approved/rejected/expired history unchanged. Verify an unconfirmed
   origin and a future final session prevent completion. Repeat checks and
   confirm completed_at stays unchanged.
3. With the owners' actual session-change/cancellation-review integrations,
   attempt new requests after completion and review of expired requests. Expect
   rejection and no event/session/request changes. Coordinate both concurrency
   orderings; do not implement their workflows inside completion.
4. After attendee modules are integrated, verify a confirmed published test event
   accepts a valid registration before completion and refuses a new attendee
   afterwards. Preserve existing registrations/history. Any deliberately open
   registration window used to isolate the status guard must belong only to
   an approved fixture; verify no new row, capacity change or confirmation email.
5. Refresh organiser/coordinator views. Completed events stay accessible in
   history, disappear from active lists, show status/expiry notices and offer
   no new request/registration actions. Check stale requests as well as fresh pages.
6. Save redacted responses, screenshots, SQL snapshots, schema/app revisions and
   Cron history. Agree the job's final active state with the team. Do not claim
   the unverified integration flows or the entire story are Done.

References:

- [Supabase Cron setup](https://supabase.com/docs/guides/cron/install)
- [Scheduling, activation and monitoring](https://supabase.com/docs/guides/cron/quickstart)
- [pg_cron execution and concurrency](https://github.com/citusdata/pg_cron)
