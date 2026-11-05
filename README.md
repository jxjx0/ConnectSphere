# ConnectSphere

Event Planning & Venue Booking System — IS212 scrum project.

---

## Setup and run

You need:

- **Python 3.13** (CI uses 3.13; 3.14 also works)
- **Node.js 22** (18+ works; CI uses 22)
- **Git**
- The team's `backend/.env` file — ask a teammate by private message

The app runs as two servers side by side: the Flask backend on
http://localhost:5000 and the React frontend on http://localhost:5173. Both
connect to the team's shared, hosted Supabase project, so there is no local
database to set up.

### macOS

**1. Clone the repo**

```bash
git clone https://github.com/jxjx0/ConnectSphere.git
cd ConnectSphere
```

**2. Install the backend**

```bash
cd backend
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

**3. Add the environment file**

Save the `.env` file you got from the team as `backend/.env`.
`backend/.env.example` lists every variable it should contain.

**4. Install Python's certificates (once per machine)**

Python from python.org ships without SSL certificates, so sending email fails
with `CERTIFICATE_VERIFY_FAILED`. Run the script that matches your version
(check with `ls /Applications | grep Python`):

```bash
"/Applications/Python 3.13/Install Certificates.command"
```

Skip this step if you installed Python with Homebrew, pyenv or Anaconda.

**5. Install the frontend**

```bash
cd ../frontend
npm install
```

**6. Run it** — two Terminal windows, both left running.

Terminal 1, from the repo root:

```bash
cd backend
venv/bin/python app.py
```

Terminal 2, from the repo root:

```bash
cd frontend
npm run dev
```

### Windows (Command Prompt)

**1. Clone the repo**

```bat
git clone https://github.com/jxjx0/ConnectSphere.git
cd ConnectSphere
```

**2. Install the backend**

```bat
cd backend
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

**3. Add the environment file**

Save the `.env` file you got from the team as `backend\.env`.
`backend\.env.example` lists every variable it should contain. Make sure
Windows didn't save it as `.env.txt`.

**4. Install the frontend**

```bat
cd ..\frontend
npm install
```

**5. Run it** — two Command Prompt windows, both left running.

Window 1, from the repo root:

```bat
cd backend
venv\Scripts\python app.py
```

Window 2, from the repo root:

```bat
cd frontend
npm run dev
```

### Open the app

Go to **http://localhost:5173**. Press `Ctrl+C` in either window to stop
that server.

Organiser and attendee accounts can be created from the sign-up page. Internal
accounts (coordinator, venue staff, etc.) can't self-register — ask the team
for the shared test logins.

### Pulled new changes?

Rerun the install commands — `venv/bin/pip install -r requirements.txt`
(Windows: `venv\Scripts\pip install -r requirements.txt`) in `backend`, and
`npm install` in `frontend`. You don't need to recreate the venv.

### Environment variables

| Variable | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Connecting to Supabase. Required — the backend starts without them, but every Supabase request fails. |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only admin key for elevated operations, including coordinator event queues and notifications. Bypasses row-level security — treat it like a password. |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | Sending notification emails. |
| `FRONTEND_ORIGIN` | Where the frontend runs, for CORS (`http://localhost:5173`). |

Without the service-role key, backend operations that require elevated access
(such as coordinator event queues) are unavailable, and in-app notifications
aren't saved. Without the SendGrid key, notification emails aren't sent; other
app functionality can still run.

> [!IMPORTANT]
> **The SendGrid free trial ends on 30 November 2026.** After that, the account
> must be upgraded or replaced, or notification emails will stop sending. The
> app keeps working and in-app inbox notifications are unaffected — failed
> emails are only logged in the backend terminal. **Never commit `.env`** or paste its
> keys into chats, Jira or PRs.

The frontend needs no `.env` locally — it defaults to
`http://localhost:5000`. Copy `frontend/.env.example` to
`frontend/.env.local` only to point it at a different backend.

### Run the tests

```bash
cd backend
venv/bin/python -m pytest
```

Windows: `venv\Scripts\python -m pytest`. Most tests use fakes for Supabase and
SendGrid, so this needs no credentials or network.

Tests that need a real database show as skipped in this run:

- The `*_database.py` tests need `CANCELLATION_TEST_DATABASE_URL`, pointing at a
  throwaway local PostgreSQL. They create and drop databases and roles, so never
  point it at a database you care about.
- The tests in `tests/integration/` need a local Supabase. See
  [Integration tests](#integration-tests).

GitHub Actions runs all of these on every push and pull request to `main`.

`backend/pytest.ini` discovers tests under `backend/tests/`. New test files
named `test_*.py` or `*_test.py`, with test functions named `test_*`, are
included automatically without changing the workflow.

### Run tests with coverage locally

From `backend`, activate the virtual environment with
`source venv/bin/activate` on macOS / Linux or
`venv\Scripts\activate.bat` in Windows Command Prompt. Then run the same
test and reporting command used by CI:

```bash
python -m pytest --cov --cov-config=.coveragerc --cov-branch --cov-report=term-missing --cov-report=xml:.reports/coverage.xml --cov-report=html:.reports/htmlcov --junitxml=.reports/test-results.xml
```

Coverage is configured in `backend/.coveragerc`. It measures backend
application code, excluding tests, manual scripts, and virtual environments.
Untouched modules are included, even in directories without `__init__.py`.

The terminal shows each file's coverage, missing line numbers, and a total
percentage. The command also generates these files inside `backend`:

| Output | Purpose |
|---|---|
| `.reports/test-results.xml` | Machine-readable test results: counts, failures, errors, and skipped tests |
| `.reports/coverage.xml` | Machine-readable coverage data used by the CI job summary |
| `.reports/htmlcov/index.html` | Open in a browser to explore coverage and highlighted untested lines |
| `.reports/.coverage` | Raw coverage data produced by Coverage.py |

These generated files and the `.reports/` directory are ignored by git.
**No coverage threshold is currently enforced.** Coverage is used to identify
untested code; a future 100% backend line-coverage gate is planned but is not
active.

### Automatic CI runs

The [Backend Test CI workflow](.github/workflows/tests.yml) runs automatically
on:

- Pull requests targeting `main`.
- Pushes to `main`.

It has three jobs, all on Ubuntu with Python 3.13:

| Job | What it runs |
|---|---|
| **Backend Tests** | The pytest suite from `backend`, with a throwaway PostgreSQL. The integration tests show as skipped here. |
| **Integration Tests** | `tests/integration`, against a private local Supabase. |
| **End-to-End Tests** | The browser tests in `e2e/`, against the Supabase project in the repository secrets. |

The last two only start if **Backend Tests** passes. Any failing test fails its
job. In **Backend Tests**, artifact uploads and the summary run afterward with
`if: always()`, so available reports can still be inspected after a test failure.

### Read results in GitHub Actions

Open **Actions → Backend Test CI → a workflow run → Summary**, or follow
the **Backend Tests** check from a pull request to its workflow run.

The **Backend Tests** job summary shows:

- Test status and passed, failed, error, and skipped counts.
- Python line coverage percentage and covered / total executable lines.
- `Coverage threshold: Not enforced yet`.
- Download links for uploaded artifacts.

The summary is generated by
[backend_test_summary.py](.github/scripts/backend_test_summary.py) using
Python's standard library. Missing, unreadable, or malformed reports are
labelled unavailable. Coverage from a failed test run is clearly identified.
The summary appears on the Actions run summary, not in the PR conversation.

For per-file coverage and missing line numbers without downloading anything,
open the **Backend Tests** job and expand **Run backend tests**.

### Download detailed reports

In the workflow run's **Artifacts** section, download:

| Artifact | Contents |
|---|---|
| `backend-test-results` | `test-results.xml` |
| `backend-coverage-report` | `coverage.xml` and the complete `htmlcov/` directory |

Extract `backend-coverage-report` and open `htmlcov/index.html` in a browser.
Keep the extracted directory together so the HTML pages, scripts, and styles
can load. The XML files are for automated reporting; teammates can use the
job summary for headline results and HTML for detailed source coverage.

Both artifacts are retained for **14 days**. After expiration, the downloads
and their summary links are no longer available. If an artifact upload does
not produce a download URL, the summary labels that artifact unavailable.

### Require passing CI before merging

To make passing CI a merge requirement, a repository administrator must
configure a branch protection rule or ruleset for `main` that requires pull
requests and the **Backend Tests** status check to pass before merging.
This is a GitHub repository setting, separate from the workflow file.

### Integration tests

The tests in `backend/tests/integration/` run the real Python services against
a real local copy of Supabase, with only SendGrid faked. They check what the
fake-based tests can't: that queries, permission rules and database functions
work together with the services. They run automatically in CI, so you only need
this setup to run them yourself.

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) open
and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
installed. Run Supabase commands from `backend/tests/integration`, where its
`supabase` folder is. From the repository root, start local Supabase:

```bash
cd backend/tests/integration && supabase start
```

Then, on macOS / Linux, run the tests from that same folder:

```bash
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
```

```bash
cd ../.. && SUPABASE_TEST_URL="$API_URL" SUPABASE_TEST_ANON_KEY="$ANON_KEY" SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" venv/bin/python -m pytest tests/integration -v
```

On Windows Command Prompt, run `supabase status -o env`, then set the values it
prints before running the tests from `backend`:

```bat
set SUPABASE_TEST_URL=<API_URL value>
set SUPABASE_TEST_ANON_KEY=<ANON_KEY value>
set SUPABASE_TEST_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY value>
venv\Scripts\python -m pytest tests\integration -v
```

Without `SUPABASE_TEST_URL` these tests are skipped, and they refuse to run
against anything except this computer. Run `supabase db reset --local` to clear
the local data and `supabase stop` when you're done.

The local schema comes from `backend/tests/integration/supabase/migrations/`, a copy of the live database
structure. **When the live schema changes, update it too**, or these tests will
drift from the real database. If you regenerate it with `supabase db dump`, add
back the sections marked `ADDED BY HAND`, or it won't load. Avoid `supabase db push` and commands
using `--linked`, other than dumping the schema, because they can change the
shared project.

### End-to-end testing

The browser tests in `e2e/` use Python Playwright to check that role-specific
pages render and that common navigation, search, filters, forms, dialogs, and
calendars are usable. These are primarily visual/navigation smoke tests, not
full CRUD or database-persistence tests.

#### Run the tests

Start the backend and frontend as described in [Setup and run](#setup-and-run).
The tests then log in to whichever Supabase project your `backend/.env` points
to. Run these commands from the repository root.

Install the browser once per machine:

**macOS / Linux**

```bash
backend/venv/bin/python -m playwright install chromium
```

**Windows Command Prompt**

```bat
backend\venv\Scripts\python -m playwright install chromium
```

Then run the tests:

**macOS / Linux**

```bash
backend/venv/bin/python -m unittest discover -s e2e -p "test_login_as_*.py" -v
```

**Windows Command Prompt**

```bat
backend\venv\Scripts\python -m unittest discover -s e2e -p "test_login_as_*.py" -v
```

The tests default to `http://localhost:5173/`. To test a different frontend
address, set `BASE_URL` before running them:

**macOS / Linux**

```bash
BASE_URL=http://localhost:5173/ backend/venv/bin/python -m unittest discover -s e2e -p "test_login_as_*.py" -v
```

**Windows Command Prompt**

```bat
set BASE_URL=http://localhost:5173/
backend\venv\Scripts\python -m unittest discover -s e2e -p "test_login_as_*.py" -v
```

#### What the tests cover

| Test file | UI journey checked |
|---|---|
| `test_login_as_attendee.py` | Attendee sign-in and events landing page. |
| `test_login_as_coordinator.py` | Coordinator event tabs and navigation to equipment and venue requests. |
| `test_login_as_organiser.py` | Event request form, adding/removing a session, review screen, and client-side date validation. |
| `test_login_as_venue_staff.py` | Venue overview, catalogue search, booking-request page, availability calendar, dismissible block dialog, and profile form navigation. |
| `test_login_as_coordinator_lead.py` | Unassigned and all-events page navigation and headings. |
| `test_login_as_safety_officer.py` | Safety queue, reviewed, and no-longer-needed page navigation and headings. |
| `test_login_as_tech_support.py` | Equipment request history, catalogue search, equipment-profile form, and shared-booking calendar. |

#### Data and side effects

The tests sign in with test accounts and load existing application data, so
they still make authentication and read-only API requests to the configured
backend/database. They do not submit event requests, save drafts, make safety
decisions, reassign coordinators, review equipment requests, save equipment
profiles, allocate equipment, create bookings, or create venue blocks. Form
and dialog checks stop before submission.

The tests expect the demo accounts and sample records used by the flows to
exist in the configured environment. Run them only against a development or
test environment, never production. `test_example.py` is a unittest/Playwright
scaffold and is not included in the role-flow command above.

#### GitHub Actions secrets

The E2E workflow needs these repository Actions secrets, exposed to its
"Start servers and run e2e tests" step:

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Used by backend authentication and user-scoped requests. |
| `SUPABASE_SERVICE_ROLE_KEY` | Used by backend admin operations exercised by role pages, including coordinator-lead event queues. |

Add them under **Settings → Secrets and variables → Actions**. The workflow
must map each secret to an environment variable with the same name; adding a
GitHub secret alone does not make it available to the backend. The service-role
key bypasses row-level security: never expose it to frontend code, commit it,
or print it in logs. GitHub does not provide repository secrets to workflows
for pull requests from forks, so those E2E runs cannot access Supabase unless
the workflow uses a separately approved test setup.

To record browser interactions while exploring the UI, start the app and run:

```bash
backend/venv/bin/python -m playwright codegen --target python http://localhost:5173/
```

Treat generated code as a starting point: keep stable role-based selectors,
add assertions for the intended page state, and avoid submitting actions that
write to the database when the test is meant to be read-only.

---

## About the app

ConnectSphere takes an event from request to completion. An **organiser**
submits an event request; it's assigned to an **event coordinator**, who
reviews it, books venues and equipment, and sends it for a safety check. Once
the **safety officer** approves it, the event is confirmed and the organiser can
publish it for **attendees** to register.

| Role | What they do |
|---|---|
| Organiser | Drafts and submits event requests, answers clarifications, requests changes or cancellation, publishes confirmed events for registration |
| Attendee | Browses published events, registers and withdraws |
| Event Coordinator | Reviews assigned requests, books venues and equipment per session, sends events for a safety check |
| Event Coordinator Lead | Sees all coordinators' workload, assigns unassigned events and reassigns coordinators |
| Venue Staff | Maintains the venue catalogue, blocks venues, approves or rejects booking requests |
| Technical Support | Maintains equipment, reviews equipment requests and allocates units |
| Safety Officer | Approves, rejects or requests changes on events before they're confirmed |

Organisers and attendees sign up themselves; every other role is an internal
account. Users are notified of key status changes in an in-app inbox and by
email.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, React Router, Axios |
| Backend | Python, Flask 3, Pydantic (request validation) |
| Database & Auth | Supabase — PostgreSQL and Supabase Auth (JWT) |
| Email | SendGrid |
| Testing & CI | pytest, pytest-cov, Playwright, Supabase CLI with Docker (integration tests), GitHub Actions |
| Project tracking | Jira |

## Project structure

```
ConnectSphere/
├── backend/
│   ├── app.py          # creates the Flask app and registers routes
│   ├── routes/         # thin HTTP handlers, one file per feature
│   ├── services/       # business logic and Supabase calls
│   ├── models/         # Pydantic data shapes and validation
│   ├── scripts/        # one-off and scheduled jobs
│   └── tests/
│       └── integration/   # real services against a local Supabase
├── e2e/                # browser tests for the whole app
├── frontend/src/
│   ├── api/            # every backend call, in one place
│   ├── pages/          # one file per screen
│   ├── components/     # shared UI
│   └── context/        # AuthContext — current user and role
├── database/           # SQL scripts for the Supabase schema
└── docs/               # ER diagram and C4 architecture diagrams
```

Authorisation is enforced on the backend and in the database: protected routes
check the user's token, role-restricted routes also check their role, and
row-level security limits what each user can read and change. The frontend's
`AuthGuard` only decides what to show.

## Documentation

- [ER diagram](docs/er-diagram.md) — database tables and relationships
- [C4 system context](docs/c4context.dsl) and
  [C4 containers](docs/c4container.dsl) — Structurizr DSL; paste into
  https://structurizr.com/dsl to render
- [Definition of Done — code quality](docs/dod-code-quality.md)
