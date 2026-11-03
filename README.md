# ConnectSphere

Event Planning & Venue Booking System — IS212 scrum project.

---

## Setup and run

You need:

- **Python 3.13** (3.11+ works; CI uses 3.13)
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
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Connecting to Supabase. Required — the backend won't start without them. |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key used by the notification service. Bypasses row-level security — treat it like a password. |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | Sending notification emails. |
| `FRONTEND_ORIGIN` | Where the frontend runs, for CORS (`http://localhost:5173`). |

Without the service-role and SendGrid keys the app still runs, but
notifications aren't saved or emailed. **Never commit `.env`** or paste its
keys into chats, Jira or PRs.

The frontend needs no `.env` locally — it defaults to
`http://localhost:5000`. Copy `frontend/.env.example` to
`frontend/.env.local` only to point it at a different backend.

### Run the tests

```bash
cd backend
venv/bin/python -m pytest
```

Windows: `venv\Scripts\python -m pytest`. The suite uses fakes for Supabase
and SendGrid, so it needs no credentials or network. The same tests run in
GitHub Actions on every push and pull request to `main`.

---

## About the app

ConnectSphere takes an event from request to completion. An **organiser**
submits an event request; it's assigned to an **event coordinator**, who
reviews it, books venues and equipment, and sends it for a safety check.
Once confirmed, the event opens for **attendees** to register.

| Role | What they do |
|---|---|
| Organiser | Drafts and submits event requests, answers clarifications, requests changes or cancellation |
| Attendee | Browses published events, registers and withdraws |
| Event Coordinator | Reviews assigned requests, books venues and equipment per session, confirms events |
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
| Testing & CI | pytest, pytest-cov, GitHub Actions |
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
├── frontend/src/
│   ├── api/            # every backend call, in one place
│   ├── pages/          # one file per screen
│   ├── components/     # shared UI
│   └── context/        # AuthContext — current user and role
├── database/           # SQL scripts for the Supabase schema
└── docs/               # ER diagram and C4 architecture diagrams
```

Authorisation is enforced on the backend: every protected route checks the
user's token and role before it runs. The frontend's `AuthGuard` only decides
what to show.

## Documentation

- [ER diagram](docs/er-diagram.md) — database tables and relationships
- [C4 system context](docs/c4context.dsl) and
  [C4 containers](docs/c4container.dsl) — Structurizr DSL; paste into
  https://structurizr.com/dsl to render
- [Definition of Done — code quality](docs/dod-code-quality.md)
