# Expense Tracker

An AI-powered expense tracker that categorizes spending automatically, including bulk
imports of bank statement CSVs through a queue-backed worker. Built as a full-stack
portfolio project.

**Live demo:** https://expense-tracker-two-pi-27.vercel.app

## Features

- Add, edit, and delete expenses, individually or all at once
- AI categorization via Claude, into a fixed eight-category vocabulary
- **CSV import** — upload a bank statement and watch it process row by row
- Live import progress over WebSockets, with polling as a fallback
- Correct any category from the list; for imported rows the correction is remembered
  per user and applied to future imports of that merchant
- Spending breakdown by category (pie chart)
- Authentication — every query is scoped to the signed-in user

## Tech Stack

- **Frontend:** React, Vite, Tailwind CSS, Recharts
- **Backend:** Node.js, Express
- **Queue:** AWS SQS, with a dead-letter queue for batches that never succeed
- **Database:** PostgreSQL (Supabase) via Prisma ORM
- **Auth:** Clerk
- **AI:** Anthropic API (Claude Haiku)
- **Deploy:** Vercel (frontend), Render (API + worker as separate services)
- **CI/CD:** GitHub Actions — runs the test suite on every push

## Architecture

Two compute paths. A single expense is categorized in the request; a CSV is not, because
10,000 rows of LLM calls do not fit in a 30-second request.

```
Browser (React)
  │
  ├── POST /expenses ──────► Express API ──► Postgres
  │                              └──► Anthropic (categorize one)
  │
  └── POST /imports (CSV) ─► Express API ──► Postgres (import + batch rows)
                                 │
                                 └──► SQS ──────────► DLQ (after 3 failed deliveries)
                                       │
                                       ▼
                                    Worker (separate process, polls SQS)
                                       │  normalize merchant
                                       │  cache lookup
                                       │  Anthropic (categorize cache misses only)
                                       │  write rows, update batch progress
                                       ▼
                                    Postgres
                                       │
                                       ▼
                              WebSocket ──► progress UI
```

The worker is a separate process because a web service gets slept or killed when it
stops serving requests, which is exactly what a poll loop does between messages.

Design decisions and the reasoning behind them live in [DESIGN.md](DESIGN.md) — batching,
idempotency, the DLQ, and why the merchant cache is shared across users.

### Things worth knowing

- **Imports are idempotent at two levels.** An import is keyed on
  `(user_id, idempotency_key)`, a row on `(import_id, row_index)`. SQS guarantees
  at-least-once delivery, so batches *will* be replayed; replaying one is a no-op rather
  than a set of duplicate expenses.
- **Batches, not rows, are the unit of retry.** One queue message covers 100 rows. A row
  that fails to parse is recorded in `ImportRowError`, with the original line and a
  reason, and the rest of the batch continues.
- **Merchants are normalized and cached.** `sq *starbucks 8823` and `SQ *STARBUCKS 1102`
  collapse to `starbucks`, which is looked up before any LLM call. Most of a real
  statement is repeat merchants, so most rows cost nothing to categorize.

## Running Locally

**Prerequisites:** Node.js, a Supabase project, a Clerk application, an Anthropic API
key, and an AWS account with an SQS queue.

**Backend** (API and worker share one package):

```bash
cd server
cp .env.example .env   # fill in your keys
npm install
npx prisma migrate dev

npm run dev            # API on :3000
npm run worker         # in a second terminal — polls SQS
```

The API serves requests and enqueues import batches; the worker consumes them. Uploading
a CSV without the worker running leaves the import stuck at 0% — nothing is lost, the
messages simply sit in the queue until a worker starts.

**Frontend:**

```bash
cd client
cp .env.example .env   # Clerk publishable key + API URL
npm install
npm run dev
```

**Tests:**

```bash
cd server
npm test
```

No database or network access needed — Prisma, Clerk, Anthropic, and SQS are all mocked.

### One-time AWS setup

```bash
cd server
node scripts/configure-dlq.js            # show what would change
node scripts/configure-dlq.js --apply    # create the DLQ and attach the redrive policy
```

Re-running without `--apply` is a drift check between the live queue and `lib/sqs.js`.
Setting queue attributes needs `sqs:SetQueueAttributes`, which the app's runtime IAM user
deliberately does not have — run it under an admin profile or set the values in the
console.

### Maintenance

```bash
node scripts/reset-merchant-cache.js --apply
```

Clears the shared merchant cache. Needed after changing `lib/categories.js` or the
categorization prompt: a cache hit never reaches the LLM, so merchants already in the
table keep their old category indefinitely. Per-user corrections are left alone.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Transaction pooler (6543). Runtime queries. |
| `DIRECT_URL` | server | Session pooler (5432). Migrations only — DDL needs session state the transaction pooler drops. |
| `CLERK_SECRET_KEY` | server | Verifies session tokens |
| `ANTHROPIC_API_KEY` | server | Categorization |
| `AWS_REGION`, `SQS_QUEUE_URL` | server | Queue location |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | server | Queue credentials |
| `VITE_CLERK_PUBLISHABLE_KEY` | client | Clerk frontend SDK |
| `VITE_API_URL` | client | API base URL |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness. Touches nothing, so a database blip is not a restart loop. |
| `GET` | `/expenses` | This user's expenses, newest first |
| `POST` | `/expenses` | Create one. The AI assigns the category. |
| `PATCH` | `/expenses/:id` | Update one. An explicit category is honoured here, and remembered for the merchant. |
| `DELETE` | `/expenses` | Delete all of this user's expenses |
| `DELETE` | `/expenses/:id` | Delete one |
| `POST` | `/imports` | Upload a CSV. Validates headers, chunks into batches, enqueues. |
| `GET` | `/imports/:id` | Import progress. The polling fallback for the WebSocket. |
| `WS` | `/ws` | Live progress for an in-flight import |

Every endpoint requires a valid Clerk JWT in the `Authorization` header, and every query
is filtered by the user id taken from it.
