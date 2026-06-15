# AI-Powered Expense Tracker

Full-stack expense tracker with AI categorization. Built as a portfolio project for SWE intern applications.

## Builder Context
- Beginner. Strong-ish on frontend (HTML/CSS/JS/React), new to backend, databases, and deployment.
- Building part-time (~6-10 hrs/week) alongside a summer internship. Internship is the priority.
- Prefer simple, well-understood tools over clever ones. Explain backend/database/devops concepts when they come up.

## Stack
- **Frontend:** React + Vite, Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL via Supabase
- **ORM:** Prisma (write JS instead of raw SQL)
- **AI:** Anthropic API (Claude) — key lives ONLY on the backend, never the frontend
- **Auth:** Supabase Auth or Clerk (do NOT hand-roll JWT)
- **Charts:** Recharts
- **Deploy:** Vercel (frontend) + Railway or Render (backend)
- **CI/CD:** GitHub Actions (one simple workflow: run tests on push, deploy on merge to main)
- **Testing:** Jest + Supertest (backend), a few React component tests. Meaningful, not exhaustive.

## Architecture Mental Model
Browser (React) → HTTP request → Express backend → Database (Postgres).
The backend is the middleman. Only the backend touches the database and secret API keys.

## Data Model
An **Expense**:
- `id` — string/uuid (DB-generated)
- `description` — string (e.g., "Starbucks coffee")
- `amount` — number (store in cents/integer to avoid float bugs, or decimal — decide and stay consistent)
- `category` — string (e.g., "Food & Drink", "Transport", "Bills") — AI-assigned, user can override
- `date` — date/timestamp
- `userId` — string (foreign key to the user; added once auth exists)
- `createdAt` — timestamp (DB-generated)

A **User** (handled largely by the auth provider):
- `id`, `email`, `createdAt`

## API Endpoints (build/test with Thunder Client before wiring the frontend)
- `GET /expenses` — list current user's expenses
- `POST /expenses` — create one (backend calls Anthropic to auto-assign `category`)
- `PATCH /expenses/:id` — edit (incl. manual category override)
- `DELETE /expenses/:id` — delete one

## Build Order (do NOT skip ahead)
1. **Static UI with hardcoded data** — React state only, no backend. List + add form + delete. ← CURRENT STEP
2. **Express API** — the four endpoints above, in-memory data, test with Thunder Client.
3. **Database** — Supabase + Prisma, swap in-memory array for DB queries.
4. **Connect frontend to backend** — replace hardcoded data with `fetch`. Expect CORS errors; that's normal.
5. **Auth** — Supabase Auth / Clerk. Scope all expenses to the logged-in user.
6. **AI categorization** — backend receives expense → calls Anthropic → saves returned category.
7. **Analytics dashboard** — Recharts: spending by category (pie), monthly trend (line).
8. **Deploy** — Vercel + Railway/Render. A live URL is the priority.
9. **Testing + CI/CD** — a handful of API tests, basic GitHub Actions workflow.
10. **README + demo GIF** — clean architecture explanation, screenshots. Recruiters skim GitHub.

## Stretch Goals (cut first if behind)
- Budget forecasting — if done, be honest about what it is (e.g., "projected spend from trailing 3-month average"), don't oversell as ML.
- Receipt photo parsing.

## Conventions
- Keep secrets in `.env`, never commit them. Add `.env` to `.gitignore` immediately.
- Frontend and backend in separate folders (e.g., `/client`, `/server`) or separate repos.
- Commit often with clear messages — the git history is itself a portfolio signal.
