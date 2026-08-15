# Async Transaction Ingestion Pipeline — Design

## Relationship to the existing expense tracker

This extends the AI Expense Tracker (see `BUILD_LOG.md` for the original build) — it
does not replace it. Everything already shipped — manual entry, single-expense AI
categorization, auth, charts, CI/CD — stays as-is. Supabase remains the Postgres host
and Prisma remains the ORM; this doc does not introduce a database migration.

What's new is a second compute path. The existing app is a single request-response
backend (`Browser → Express → Postgres`). This adds a worker process that runs
independently of the Express server, polling SQS and writing to the same Postgres
database Prisma already points at. That worker needs its own deploy target — see
**Deployment** below — since Render/Railway web services aren't built for long-running
poll loops.

## Problem

Users import bank statements as CSV exports. A naive implementation parses the file
inside the request handler and calls an LLM once per row to categorize it. This breaks
at realistic file sizes:

- **Timeouts.** 10,000 rows × ~300ms per categorization call is ~50 minutes of work
  inside a request that dies at 30s.
- **All-or-nothing failure.** One malformed row or one API error aborts the whole import.
- **Unsafe retries.** A user who re-uploads after a failure gets duplicate transactions,
  corrupting every downstream balance and trend.
- **Cost.** One LLM call per row, with heavy repetition across merchants, is wasteful.

The system decouples ingestion from the request lifecycle so work can outlive the
connection, fail partially, and retry safely.

## Non-goals

- Bank account linking (Plaid or equivalent). Input is user-uploaded CSV.
- Multi-tenant scale. Design targets correctness under concurrency, not throughput.
- Real-time categorization on single-transaction entry, which stays synchronous.

## Architecture

```
Client
  │  POST /imports  (multipart CSV + Idempotency-Key)
  ▼
API (Express)
  │  1. validate headers, reject unparseable files early
  │  2. persist Import row (status=PENDING)
  │  3. chunk rows into batches of N, enqueue one message per batch
  ▼
Queue (SQS)  ──── DLQ (after maxReceiveCount)
  │
  ▼
Worker (containerized, polls SQS)
  │  1. normalize merchant strings
  │  2. cache lookup by normalized hash
  │  3. LLM categorize cache misses (batched)
  │  4. upsert transactions, update batch progress
  ▼
Postgres  ──►  WebSocket server  ──►  Client progress UI
```

## Implementation status

Tracked here rather than in `CLAUDE.md`, which is for conventions and is re-read every
session — a task list there goes stale silently.

- [x] Data model and migration (`imports`, `import_batches`, `transactions`,
      `merchant_cache`, `merchant_overrides`, row errors)
- [x] Merchant normalization and hashing (`lib/normalize.js`)
- [x] Two-layer category lookup with per-user override precedence (`lib/merchantCache.js`)
- [x] SQS wrapper shared by both processes (`lib/sqs.js`)
- [x] `POST /imports` — parse, validate headers, persist, chunk, enqueue
- [x] Worker entrypoint and poll loop (`worker.js`, `worker/poller.js`)
- [x] Batch processing: normalize → lookup → LLM misses → upsert on `(import_id, row_index)`
      (`worker/processBatch.js`, `worker/categorize.js`, `worker/parseRow.js`)
- [x] Partial failure: `ImportRowError` rows, batch continues
- [x] Redelivery/duplicate test coverage (write before the processing logic)
- [x] Poison-batch test (`__tests__/poisonBatch.test.js`) and the DLQ setup script
      (`scripts/configure-dlq.js`)
- [x] Progress over WebSockets (`lib/ws.js`) and the `GET /imports/:id` fallback
- [x] Client upload UI and progress (`ImportUpload.jsx`, `useImportProgress.js`)
- [x] Deploy config for both services (`render.yaml`)

- [x] `ImportBatch.error` migration applied — `prisma migrate status` reports all five
      migrations in place
- [x] DLQ attached and reconciled with the code. `expense-imports` (us-east-2) redrives
      to `expense-imports-dlq` at `maxReceiveCount` **3**, matching `MAX_RECEIVE_COUNT` in
      `lib/sqs.js`, with 14-day retention on the DLQ. The worker's last-delivery bookkeeping
      therefore fires on the delivery the queue actually gives up on.

Left to do, and all of it needs a console or credentials rather than code:

- [ ] Apply `render.yaml` as a Render Blueprint and set the secrets it declares

Done since:

- [x] CloudWatch alarm on the DLQ. Fires on `ApproximateNumberOfMessagesVisible > 0`
      (Maximum over 5 minutes) for `expense-imports-dlq`, notifying an SNS topic. Maximum
      rather than Sum, which would add repeated samples of the same sitting message and
      read high. Created in the console — the app's IAM user has no `cloudwatch:*`, so
      this cannot be verified from the repo; check the SNS subscription reads Confirmed
      rather than PendingConfirmation, which is the way this silently does nothing.
- [x] Queue visibility timeout raised to **300s** (set in the console; the app's IAM user
      is scoped to runtime actions and cannot write queue attributes). With
      `maxReceiveCount` at 3 that gives a batch ~15 minutes of retries, and a batch no
      longer risks redelivery while its Anthropic call is still in flight. Verified with
      `node scripts/configure-dlq.js`, which now reports no drift between the queue and
      `lib/sqs.js`.
- [x] Split the two database URLs. `DATABASE_URL` now points at the transaction pooler
      (6543, `?pgbouncer=true`) and `DIRECT_URL` at the session pooler (5432) for the DDL
      migrations run — the shape `.env.example` already documented, which the live `.env`
      had drifted from by pointing both at 5432. Verified both paths: `prisma migrate
      status` over the direct URL, and a live query over the pooled one.

## Key decisions

### Queue over in-process background job

A `setImmediate` or worker thread loses all queued work when the container restarts,
which happens on every deploy. SQS persists messages independently of process
lifetime and provides redelivery on worker crash for free.

**Tradeoff:** added infrastructure and eventual consistency in the UI. Accepted because
losing a user's in-flight import on deploy is unacceptable, and the UI already needs a
progress channel.

### At-least-once delivery, made safe by idempotency

SQS standard queues guarantee at-least-once, not exactly-once. Duplicate deliveries are
expected, not exceptional. Two layers of protection:

1. **Import-level.** The client sends an `Idempotency-Key` header. A unique constraint on
   that key means a retried upload returns the existing import instead of creating a new one.
2. **Row-level.** Each transaction gets a deterministic key derived from
   `(import_id, row_index)`. Writes are `INSERT ... ON CONFLICT DO NOTHING`, so replaying
   a batch is a no-op rather than a duplicate.

Chose FIFO-free standard queues deliberately: ordering does not matter here, and
idempotent writes are a stronger guarantee than deduplication windows.

### Batch granularity

One message per batch of N rows, rather than one message per row.

- Per-row messages: maximum failure isolation, but 10,000 messages and 10,000 round trips.
- Whole-file message: one message, but a single failure retries the entire file and the
  visibility timeout is impossible to size.

Batching at N gives bounded retry cost and a natural progress unit. N is tuned so a batch
completes well inside the visibility timeout.

### Partial failure

A batch is not atomic. Rows that fail validation are written to `import_row_errors` with
the original line and a reason; successful rows commit normally, in the same transaction.
A separate table rather than a status column on `transactions`, so `Expense` keeps meaning
money actually spent and no listing query needs a status filter. The import completes with
a count of failed rows the user can review and re-submit, recounted from that table rather
than accumulated so a redelivered batch cannot double-count. A single bad row never blocks
the other 9,999 — and critically, a bad row must never throw out of the batch handler, or
one malformed line would drag the whole batch to the DLQ.

### Dead-letter queue

After `maxReceiveCount` redeliveries, a batch moves to the DLQ rather than looping
forever. This distinguishes transient failures (API timeout, worth retrying) from
deterministic ones (malformed batch, retrying forever burns money). DLQ contents are
inspectable and manually replayable.

### Merchant normalization and caching

Raw descriptors are noisy and highly repetitive:

```
STARBUCKS #4471 SEATTLE WA   ─┐
STARBUCKS #0912 ANN ARBOR MI ─┼─► "starbucks" ─► cache hit ─► "Coffee"
SQ *STARBUCKS 8823           ─┘
```

Normalization strips store numbers, location suffixes, and payment-processor prefixes,
then hashes the result. The cache is keyed on that hash, so the LLM is called once per
distinct merchant rather than once per transaction. This is the primary cost and latency
lever in the system.

**Tradeoff:** over-aggressive normalization collides distinct merchants. Rules are
conservative and the cache is invalidatable per key.

### Progress over WebSockets

The client cannot poll cheaply for a job that takes minutes. The worker updates batch
progress in Postgres; the WebSocket server pushes deltas to subscribers of that import.
Connections are scoped by user, and the fallback if the socket drops is a REST endpoint
returning current import status.

**How the worker's writes reach the socket.** The worker and the API are separate
processes, so the worker cannot touch the API's sockets. Three ways to bridge that were
possible: the worker calls an internal API endpoint, Postgres `LISTEN/NOTIFY`, or the
API polls. The API polls — but only imports that someone currently has open, once per
import rather than once per viewer, and it only sends a frame when the numbers changed.

That is not what "polling is too expensive" in the opening paragraph rules out. What is
ruled out is every client polling over the internet on its own timer; one server-side
query every 1.5 seconds for an import a human is actively watching is a rounding error
next to the LLM calls happening at the same time. The alternatives cost more than they
return here: an internal endpoint means a second auth surface between our own services,
and `LISTEN/NOTIFY` does not survive Supabase's transaction pooler, which is what
`DATABASE_URL` points at.

**Tradeoff:** up to 1.5s of staleness, and the API does work proportional to viewers
rather than to events. Revisit if a single import is ever watched by many people at once.

### Row validation and the sign of an amount

`amount` is stored as the magnitude in cents. Bank exports disagree about the sign of a
debit — some write a purchase as `-6.50`, others as `6.50` — and `Expense` already means
money spent, so the sign carries no information the column needs. `(1.23)`, `$`, and
thousands separators are accepted and stripped.

Dates are accepted as `YYYY-MM-DD` or `MM/DD/YYYY` and rejected otherwise. Anything more
permissive has to guess at `03/04`, and silently importing a wrong date is worse than
telling the user which row we could not read.

## Data model (relevant tables)

| Table | Purpose | Notable constraints |
|---|---|---|
| `imports` | One per uploaded file | `UNIQUE(user_id, idempotency_key)` |
| `import_batches` | Progress unit, one per queue message | `UNIQUE(import_id, batch_index)` |
| `transactions` | Final rows | `UNIQUE(import_id, row_index)` |
| `merchant_cache` | Normalized merchant → category | PK on normalized hash |

All queries are scoped by `user_id`; per-user isolation is enforced at the query layer,
not in application logic.

## Deployment

The Express API and the worker are separate deploy targets — they don't share a
process and shouldn't share a service.

- **API:** stays on Render/Vercel as-is, no change from the existing tracker.
- **Worker:** deployed as a Render (or Railway) background worker service — a
  long-running process type built for exactly this: poll a queue, no HTTP listener
  needed.
- **Why not ECS/Fargate here:** that's already the deploy pattern on the Distributed
  Rate Limiter project. Repeating it adds real setup cost (VPC, task definitions, IAM
  scoping, Terraform state) without adding resume signal — the bullet for this project
  is about queue semantics and idempotency, not infra, so the deployment target never
  surfaces there. Time is better spent on the parts that are actually new: batching,
  retries, the DLQ, normalization.
- If asked in an interview why the two projects deploy differently, that's a fine,
  honest answer: match the tool to the job rather than defaulting to what you already
  know.

## Failure modes

| Failure | Behavior |
|---|---|
| Worker crashes mid-batch | Visibility timeout expires, batch redelivered, idempotent writes make replay safe |
| LLM API unavailable | Batch fails, retried with backoff, DLQ after max attempts |
| Malformed row | Row marked `FAILED`, batch continues |
| Duplicate upload | Idempotency key returns existing import |
| WebSocket disconnect | Client falls back to polling import status endpoint |
| Postgres unavailable | Batch fails and redelivers; no partial commit |

## Open questions

- ~~Cache invalidation policy for merchant categories the user manually corrects.~~
  Resolved: a correction writes a per-user `MerchantOverride` that shadows the shared
  cache rather than invalidating it, so one user's fix never changes anyone else's
  default. See `lib/merchantCache.js`.
- Whether to expose DLQ replay to users or keep it operator-only.
- Backpressure if a single user uploads many large files concurrently.
