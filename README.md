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
| Tests | pytest | Runs the backend test suite |
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

Two steps: create the virtual environment, then install the dependencies into
it.

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

### 3. Environment file

Ask the team for the `.env` file and save it as `backend/.env` — that exact
name, directly inside the `backend` folder. It holds the Supabase credentials
the backend needs to start, and it is not in the repo.

**Never commit `.env`.** It's gitignored — keep it that way.

### 4. Frontend

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

The `profiles` table already exists in the shared hosted Supabase project.
There is nothing to create or migrate locally — everyone connects to the same
remote database.

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

## Running the tests

**macOS / Linux**

```bash
cd backend
venv/bin/pytest
```

**Windows (Command Prompt)**

```bat
cd backend
venv\Scripts\pytest
```

## Testing and Continuous Integration

The backend uses `pytest`. Run the test suite locally with:

```bash
cd backend
python -m pytest -v
```

The project uses GitHub Actions for continuous integration. The CI workflow
runs on pull requests targeting `main` and on pushes to `main`. It uses Python
3.13, installs dependencies from `backend/requirements.txt`, and runs the
backend pytest suite automatically. If any backend test fails, the CI check
fails.

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

