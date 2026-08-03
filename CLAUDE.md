# CLAUDE.md

Context for Claude Code working in this repo. See `DESIGN.md` for architecture and
the reasoning behind it — don't duplicate that here, reference it.

## Stack

Node, Express, PostgreSQL (Prisma), AWS SQS, WebSockets, Anthropic API, Jest, GitHub Actions.

## Commands

- Install: `npm install`
- Dev server (API): `npm run dev`
- Run worker: `npm run worker`
- Test: `npm test`
- Test, single file: `npm test -- path/to/file.test.js`
- Lint: `npm run lint`
- Lint, fix: `npm run lint -- --fix`
- DB migrate (dev): `npx prisma migrate dev`
- DB studio: `npx prisma studio`

## Conventions

- Architecture and design decisions live in `DESIGN.md` — read it before proposing
  changes to queue structure, batching, or retry logic. If an implementation needs to
  deviate from it, update the doc, don't let it drift silently.
- All database queries must be scoped by `user_id`. Never write a query that could
  return another user's rows.
- Idempotency is load-bearing, not optional: imports are keyed by
  `(user_id, idempotency_key)`, transactions by `(import_id, row_index)`. Any new
  write path touching these tables needs the same guarantee.
- Batches are the unit of retry and progress, not individual rows. Don't introduce
  per-row queue messages.
- New API endpoints need a corresponding test in `__tests__/`. Worker logic needs
  coverage for at least one redelivery/duplicate scenario, not just the happy path.
- Prefer explicit error handling over silent catch blocks, especially in the worker —
  a swallowed error there is a batch stuck in PENDING with no signal.

## Development workflow

- **Test-first for anything with a failure mode.** Before writing the batching logic,
  the idempotency check, or the DLQ path, write the test that describes the behavior
  (including the failure case from the `DESIGN.md` failure-modes table) so it fails,
  then implement to make it pass. Straightforward CRUD (a new field on an endpoint)
  doesn't need this ceremony — reserve TDD for the parts that are actually tricky:
  concurrency, retries, partial failure.
- **Small, reviewable commits.** One logical change per commit, not "wip" dumps. Each
  commit should leave tests passing.
- **Fail fast, fail loud.** No silent fallbacks that mask a broken assumption — a
  misconfigured env var or an unreachable queue should error at startup, not surface
  three layers deep as an obscure bug.
- **Feature branches, PR before merge to main**, even solo — keeps `main` deployable
  and gives you a diff to walk through in an interview.
- **Don't build ahead of the current step.** If implementing the worker, don't also
  refactor the API's auth layer in the same pass. Separate concerns, separate commits.
- **Dependency direction matters.** Worker and API both depend on `/lib` (normalization,
  cache, db client); `/lib` depends on neither. Don't let the worker reach into `/api`
  internals or vice versa.

## Code style

- ESLint + Prettier govern formatting — don't hand-format, run the lint fix command
  instead of arguing with it.
- `async/await` over raw `.then()` chains.
- No silent `catch {}` blocks — see worker error-handling note above.
- Prefer named exports over default exports.
- Functions that touch the database take `userId` as an explicit parameter; never
  pull it implicitly from a shared/global context.
- Env vars validated at startup (fail fast), not read ad hoc where used.
- Commit messages: short imperative subject line (`add batch retry logic`, not
  `added` or `adding`).

## Structure (adjust as the repo takes shape)

`client/` (React + Vite) and `server/` are separate. The API and the worker are two
processes but **one** npm package — same `server/package.json`, different entrypoints,
deployed as two Render services with different start commands.

```
server/
  index.js    API entrypoint    — loads + validates env, then listens
  worker.js   worker entrypoint — loads + validates env, then polls SQS
  app.js      builds the Express app (no listen, no env loading)
  api/        routers, request handlers, enqueue logic, HTTP middleware
  worker/     SQS poller, categorization, upserts
  lib/        shared: prisma client, env, normalization, cache, WS broadcast
  prisma/     schema.prisma, migrations
  __tests__/
```

`api/` and `worker/` may import from `lib/`; `lib/` imports from neither, and nothing
in `worker/` reaches into `api/`.

Entrypoints load and validate configuration; modules stay importable. `app.js` must not
call `validateEnv()` — the test suite imports it directly and CI runs without a
`DATABASE_URL`.

## Out of scope

- Bank account linking / Plaid. Input is user-uploaded CSV only.
- Multi-tenant throughput tuning. Optimize for correctness under concurrency first.
