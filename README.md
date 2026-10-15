# ConnectSphere

Event Planning & Venue Booking System — IS212 scrum project.

ConnectSphere lets event organisers plan events and book venues, and lets
attendees register for them. Users act in one of five roles: **organiser** and
**attendee** self-register, while **coordinator**, **venue staff** and **tech
support** are internal accounts created by the team.

---

## Stack

| Layer | Choice | What it's for |
|---|---|---|
| Frontend | React 18 + Vite, `react-router-dom` | UI, dev server, client-side routing |
| Backend | Flask 3 (Python) | HTTP API the frontend calls |
| Validation | Pydantic | Checks incoming data is the right shape |
| Database & Auth | Supabase (Postgres + built-in auth) | Stores users and profiles, issues tokens |
| Tests | pytest + pytest-cov | Runs the backend test suite and measures application coverage |
| Tracking | Jira | Stories and sprints |

## How it's put together

The backend splits every feature across three layers, one file per layer:

```
routes/     thin handlers — parse the request, call a service, return JSON
services/   business logic and all Supabase calls
models/     data shapes and validation (Pydantic)
```

The frontend follows the same idea:

```
api/          all backend calls, centralised
pages/        data fetching and page state
components/   shared UI
context/      AuthContext — current user and role, app-wide
```

Auth is enforced on the **backend**. `require_auth` in `routes/auth.py` verifies
the token before a protected handler runs — that's the real security boundary.
The frontend's `AuthGuard` only decides what to render, and is not a security
control on its own.

New features in later sprints should follow this same shape rather than
inventing a new one.

---

## First-time setup

You need **Python 3.11+**, **Node 18+**, and access to the team's Supabase
project.

### 1. Clone and enter the repo

```bash
git clone <repo-url>
cd ConnectSphere
```

### 2. Backend

Two steps: create the virtual environment (`venv`, a private folder of Python
packages for this project), then install the dependencies into it.

**macOS / Linux**

```bash
cd backend
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

**Windows (Command Prompt)**

```bat
cd backend
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

**Already set up?** After pulling changes that add a package to
`requirements.txt`, you don't need to recreate the venv — just rerun the
install line (`venv/bin/pip install -r requirements.txt`, or
`venv\Scripts\pip install -r requirements.txt` on Windows).

### 3. Environment file

Ask the team for the `.env` file and save it as `backend/.env` — that exact
name, directly inside the `backend` folder. It is not in the repo.
`backend/.env.example` lists every variable it needs:

| Variable | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Connecting to Supabase. Required — the backend won't start without them. |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key used only by the notification service. Skips row-level security, so treat it like a password. |
| `SENDGRID_API_KEY` | Sending notification emails through SendGrid. |
| `SENDGRID_FROM_EMAIL` | The sender address: `connectspheret7@gmail.com`. |
| `FRONTEND_ORIGIN` | Where the frontend runs, for CORS. |

Without the last three keys the app still runs, but notifications are not
saved or emailed.

**Never commit `.env`**, and never paste its keys into chats, Jira or PRs. It's
gitignored — keep it that way. Get the values from a teammate by private
message.

### 4. macOS only: install Python's certificates

Python installed from python.org does not come with security certificates, so
the backend can't connect to SendGrid to send emails (you'd see
`CERTIFICATE_VERIFY_FAILED`). Fix it once per machine:

1. Find your version: `ls /Applications | grep Python` (e.g. `Python 3.12`)
2. Run the matching script, e.g.:

   ```bash
   "/Applications/Python 3.12/Install Certificates.command"
   ```

   or double-click **Install Certificates.command** in Finder → Applications →
   Python 3.x.

Windows, Homebrew, pyenv and Anaconda Python don't need this.

### 5. Frontend

**macOS / Linux**

```bash
cd ../frontend
npm install
```

**Windows (Command Prompt)**

```bat
cd ..\frontend
npm install
```

No `.env` needed for the frontend in local development — it defaults to
`http://localhost:5000`, which is where the backend runs. Only copy
`.env.example` to `.env.local` if you need to point at a different backend.

### About the database

The app connects to the shared hosted Supabase project. Before using the
equipment-request feature, apply `database/equipment_requests.sql` once in the
Supabase SQL Editor; it creates the request tables and the atomic submission
function. If an earlier version of that migration was already applied, also
apply `database/equipment_request_hardening.sql` to update assignment access,
eligible event statuses and request review statuses without deleting rows.
Other SQL files in `database` document the existing schema.

---

## Running the app

Two terminals: one for the backend, one for the frontend. Leave both running
while you work.

### macOS / Linux

Terminal 1 — backend (http://localhost:5000)

```bash
cd backend
venv/bin/python app.py
```

Terminal 2 — frontend (http://localhost:5173)

```bash
cd frontend
npm run dev
```

### Windows (Command Prompt)

Terminal 1 — backend (http://localhost:5000)

```bat
cd backend
venv\Scripts\python app.py
```

Terminal 2 — frontend (http://localhost:5173)

```bat
cd frontend
npm run dev
```

Then open http://localhost:5173. Press `Ctrl+C` in either terminal to stop that
server.

## Testing and Continuous Integration

### Run backend tests locally

Use Python 3.13 locally to match CI. After completing the backend setup,
run the following commands from the repository root. They use the backend
virtual environment directly and install any newly added dependencies.

**macOS / Linux**

```bash
cd backend
venv/bin/python -m pip install -r requirements.txt
venv/bin/python -m pytest -v
```

**Windows (Command Prompt)**

```bat
cd backend
venv\Scripts\python -m pip install -r requirements.txt
venv\Scripts\python -m pytest -v
```

`backend/pytest.ini` discovers tests under `backend/tests/`. New test files
named `test_*.py` or `*_test.py`, with test functions named `test_*`, are
included automatically without changing the workflow. Tests use fakes for
Supabase and SendGrid; no real database connection or service credentials
are needed to run the suite.

### Run tests with coverage locally

From `backend`, activate the virtual environment with
`source venv/bin/activate` on macOS / Linux or
`venv\Scripts\activate.bat` in Windows Command Prompt. Then run the same
test and reporting command used by CI:

```bash
python -m pytest --cov --cov-config=.coveragerc --cov-report=term-missing --cov-report=xml:coverage.xml --cov-report=html:htmlcov --junitxml=test-results.xml
```

Coverage is configured in `backend/.coveragerc`. It measures backend
application code, excluding tests, manual scripts, and virtual environments.
Untouched modules are included, even in directories without `__init__.py`.

The terminal shows each file's coverage, missing line numbers, and a total
percentage. The command also generates these files inside `backend`:

| Output | Purpose |
|---|---|
| `test-results.xml` | Machine-readable test results: counts, failures, errors, and skipped tests |
| `coverage.xml` | Machine-readable coverage data used by the CI job summary |
| `htmlcov/index.html` | Open in a browser to explore coverage and highlighted untested lines |
| `.coverage` | Raw coverage data produced by Coverage.py |

These generated files and the `htmlcov/` directory are ignored by git.
**No coverage threshold is currently enforced.** Coverage is used to identify
untested code; a future 100% backend line-coverage gate is planned but is not
active.

### Automatic CI runs

The [Backend Test CI workflow](.github/workflows/tests.yml) runs automatically
on:

- Pull requests targeting `main`.
- Pushes to `main`.

It uses Ubuntu and Python 3.13, installs `backend/requirements.txt`, and runs
the complete pytest suite from `backend`. Any failing test fails the CI job.
Artifact uploads and the summary run afterward with `if: always()`, so
available reports can still be inspected after a test failure.

### Read results in GitHub Actions

Open **Actions → Backend Test CI → a workflow run → Summary**, or follow
the **Backend Tests** check from a pull request to its workflow run.

The job summary shows:

- Test status and passed, failed, error, and skipped counts.
- Total coverage percentage and covered / total executable lines.
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

---

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness check |
| `POST` | `/signup` | — | Register an organiser or attendee |
| `POST` | `/login` | — | Log in, returns an access token |
| `GET` | `/me` | Bearer token | Current user's profile |
| `GET` | `/events/review` | Coordinator | All requests assigned to them (any status except draft) |
| `GET` | `/events/review/<event_id>` | Coordinator | Assigned request details |
| `POST` | `/events/review/<event_id>/approve` | Coordinator | Approve an assigned request under review (moves it to planning) |
| `POST` | `/events/review/<event_id>/reject` | Coordinator | Reject an assigned request under review |

`/signup` accepts only external roles (`organiser`, `attendee`). Internal roles
are rejected server-side regardless of what the client sends.

---

## Project structure

```
ConnectSphere/
├── backend/
│   ├── app.py               # app factory, registers blueprints
│   ├── config.py            # env vars, Supabase client
│   ├── routes/              # health.py, auth.py
│   ├── services/            # auth_service.py
│   ├── models/              # profile.py — Role, SignupRequest, Profile
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/             # auth.js
│       ├── context/         # AuthContext.jsx
│       ├── components/      # AuthGuard.jsx, AppShell.jsx, SplitLayout.jsx
│       ├── pages/           # Landing, Login, Signup (x2), Dashboard
│       └── App.jsx          # routes
```

Note: `venv/` and `node_modules/` are gitignored. They're rebuilt from
`requirements.txt` and `package.json`, so each person creates their own.

---

## Appendix: two libraries worth knowing

The two least self-explanatory parts of the backend, if you haven't met them
before.

### Pydantic — validation

Pydantic turns a class into a set of rules about data. You declare the shape you
expect; anything that doesn't match is rejected before it reaches your logic.

From `models/profile.py`:

```python
class SignupRequest(BaseModel):
    """The body of POST /signup."""

    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: Role
```

Four lines, and every rule is visible: the name is 1–120 characters, the email
has to look like an email, the password is at least 8 characters, and the role
must be one of the five in the `Role` enum.

Using it is a single line — `routes/auth.py` does:

```python
signup_request = SignupRequest(**(request.get_json(silent=True) or {}))
```

Either you get back a clean, guaranteed-valid object, or Pydantic raises
`ValidationError` and the route returns a 400 listing what was wrong. The
handler below that line never has to check anything.

You can also add your own rules with `@field_validator`, written as a method
inside the model, below the fields. This one is a security boundary, not a
formatting check — it's what stops someone signing up as staff by editing the
request the frontend sends:

```python
EXTERNAL_ROLES = {Role.ORGANISER, Role.ATTENDEE}


class SignupRequest(BaseModel):
    ...                                  # the fields shown above

    @field_validator("role")
    @classmethod
    def validate_external_role(cls, value: Role) -> Role:
        if value not in EXTERNAL_ROLES:
            raise ValueError(
                f"'{value.value}' accounts cannot be self-registered. "
                "Contact the ConnectSphere team."
            )
        return value
```

### pytest — tests

pytest looks in `backend/tests/`, finds every function whose name starts with
`test_`, and runs it. A test is an ordinary function that ends in an `assert` —
if the assertion is false, the test fails.

**Fixtures** are reusable setup, defined once in `conftest.py`:

```python
@pytest.fixture
def client(app):
    return app.test_client()
```

Any test that takes a `client` argument is handed one automatically. It's a fake
HTTP client for the Flask app, so tests can make requests with no server
running:

```python
def test_signup_with_missing_fields_is_rejected(client):
    response = client.post("/signup", json={"email": "ada@example.com"})

    assert response.status_code == 400
```

**Parametrize** runs one test over several inputs. This is three tests from one
function — one per internal role:

```python
@pytest.mark.parametrize("role", ["coordinator", "venue_staff", "tech_support"])
def test_internal_roles_may_not_self_register(role):
    with pytest.raises(ValidationError) as caught:
        SignupRequest(**{**VALID_SIGNUP, "role": role})

    assert "cannot be self-registered" in str(caught.value)
```

**Our tests never contact Supabase.** Where a route would call the auth service,
the test swaps in a stand-in that returns a fixed answer:

```python
monkeypatch.setattr(
    auth_service,
    "signup",
    lambda request: {"access_token": "token-123", "profile": organiser_profile},
)
```

So the suite checks our own wiring — status codes, request parsing, error
shapes — and runs in seconds with no network and no credentials. The tradeoff:
it can't tell you whether Supabase itself is configured correctly.
