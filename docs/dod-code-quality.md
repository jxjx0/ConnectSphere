# Definition of Done — Code Quality

**Version:** 1.0 
· **Last updated:** 2 October 2026

## Backend

- [ ] **Follows the layer pattern.**
  - `routes/` handlers stay thin: parse the request, check the role, call
    the service, return JSON.
  - All Supabase calls live in `services/`.
  - Request bodies are validated by a Pydantic model in `models/`. Raw
    request JSON is never passed straight to the database.
- [ ] **Errors are handled the shared way.**
  - Services turn Supabase errors into `AuthError` with a suitable status
    code, as `_database_error` does in `services/event_service.py`.
  - No catch-all `except Exception` in routes or services.
  - No raw error text (`str(e)`) is sent to the client.
- [ ] **Every protected route is checked on the backend.**
  - It uses `@require_auth`, plus a role check (such as
    `_require_organiser()`) wherever only certain roles are allowed.
  - Error messages match what the user was actually trying to do.
- [ ] **The right Supabase client is used.**
  - `get_user_client(token)` for anything a user does, so row-level
    security applies.
  - `get_admin_client()` only where the system acts on its own behalf.

## Frontend

- [ ] **All backend calls go through `api/`**, using the shared `request`
  helper.
- [ ] **Pages get the token from `useAuth()`**, not by reading
  `localStorage` directly.
- [ ] **Protected pages are wrapped in `AuthGuard`** with the right
  `allowedRoles`.
- [ ] **Styling stays minimal and functional** until the team confirms a
  design system.

## Both

- [ ] **No leftover clutter.** This means no:
  - duplicate or unused imports
  - unused variables
  - commented-out code
  - debug `print` or `console.log` statements
- [ ] **No secrets in the code.** Keys and URLs come from `.env`, and any
  new variable is added to `.env.example`.
- [ ] **Clear names and focused functions.**
  - A function does one thing.
  - Names say what something is or does.
  - Comments explain *why*, not *what*.
- [ ] **Matches the existing code.** New code follows the patterns already
  in the repo rather than introducing a new library or style for the same
  job (for example, `fetch` vs `axios`).
- [ ] **Stays in scope.** The PR only contains what the story asks for.
- [ ] **Explainable by anyone.** A teammate who didn't write it could
  explain it in the graded Q&A after reading it once.

---