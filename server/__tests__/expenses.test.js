const request = require('supertest')

// --- Mocks ---
// Three things get faked here, each for a different reason. All of them must
// be declared before `require('../app')` below, because that require is what
// pulls in the real modules — once a module is loaded, it's too late to
// replace it.

// Who is "signed in" for the current test.
//
// The mock reads this variable lazily, on every getAuth() call, rather than
// capturing its value once. That's what lets a single test file cover both
// the logged-out and logged-in cases: each test assigns to mockUserId and the
// next request through the app sees the new identity.
//
// The `mock` prefix on the name is load-bearing, not style. Jest hoists
// jest.mock() calls above every import in the file, and rejects factories that
// reference outside variables — with a deliberate exemption for names starting
// with "mock", on the assumption you know what you're doing.
let mockUserId = null

// Mock 1: Clerk. Replaces the auth provider so tests need no API keys and no
// network. clerkMiddleware becomes a no-op; getAuth reports whoever the
// current test says is signed in.
//
// Worth being precise about what this does and doesn't prove. It does NOT test
// that Clerk validates tokens correctly — that's Clerk's code and Clerk's
// problem. It injects an identity so the tests below can check what THIS
// codebase does with one: namely, whether every query is scoped to it. That
// scoping is the rule in CLAUDE.md, and it's a property of the handlers, so
// faking the identity source doesn't weaken the test at all.
jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  getAuth: () => ({ userId: mockUserId }),
}))

// Mock 2: Prisma. Keeps the suite fast and database-free — CI has no
// DATABASE_URL, and these tests assert on the queries the handlers BUILD
// rather than on rows that come back.
//
// The limitation is worth stating out loud: asserting that the handler passed
// `where: { userId }` trusts Prisma and Postgres to actually honor that
// filter. That's a fair thing to trust. What it catches is the regression that
// realistically happens — someone editing a handler and dropping the filter.
// Proving isolation end-to-end needs a real test database; that belongs in a
// separate integration suite, not this one.
jest.mock('../lib/prisma', () => ({
  prisma: {
    expense: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}))

// Mock 3: the Anthropic SDK, for the categorization call in POST /expenses.
//
// This one is not optional. POST swallows Anthropic failures on purpose (see
// the route handler), so an unmocked test would still PASS while firing a real,
// billed API call on every run — a silently expensive green suite.
const mockAnthropicCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }))
)

// '../app' rather than './app' — this file now sits one directory deeper.
// Requiring app.js directly (instead of index.js) is what keeps the suite
// runnable without a DATABASE_URL: index.js is where validateEnv runs.
const app = require('../app')

// Grab the mocked client. Node's module cache means this is the same object
// the route handlers hold, so assertions here see the calls they made.
const { prisma } = require('../lib/prisma')

// A stand-in row, shaped like the real schema: amount in cents, date as a
// "YYYY-MM-DD" string.
const ALICE = 'user_alice'
const BOB = 'user_bob'
const expenseRow = {
  id: 'exp_1',
  userId: ALICE,
  description: 'Coffee',
  amount: 650,
  category: 'Food & Drink',
  date: '2026-06-18',
}

beforeEach(() => {
  // Wipes recorded calls between tests so one test's requests can't satisfy
  // another's assertions. clearAllMocks (not resetAllMocks) leaves
  // implementations intact, which is why the default below survives.
  jest.clearAllMocks()

  // Default to logged-out. Authenticated tests opt in explicitly, so nothing
  // is accidentally authenticated by a value left over from a previous test.
  mockUserId = null

  // A working default for the AI call. Tests about the failure path override it.
  mockAnthropicCreate.mockResolvedValue({ content: [{ text: 'Food & Drink' }] })
})

describe('Expense API auth guards', () => {
  test('GET /expenses with no token returns 401', async () => {
    const res = await request(app).get('/expenses')
    expect(res.status).toBe(401)
  })

  test('POST /expenses with no token returns 401', async () => {
    const res = await request(app).post('/expenses').send({ description: 'test', amount: 100, date: '2026-06-18' })
    expect(res.status).toBe(401)
  })

  test('PATCH /expenses/:id with no token returns 401', async () => {
    const res = await request(app).patch('/expenses/some-id').send({ description: 'test' })
    expect(res.status).toBe(401)
  })

  test('DELETE /expenses/:id with no token returns 401', async () => {
    const res = await request(app).delete('/expenses/some-id')
    expect(res.status).toBe(401)
  })

  // The 401s above prove the request was rejected. This proves it was rejected
  // EARLY — requireAuth ends the request before any handler runs, so an
  // unauthenticated caller never causes a database query at all.
  test('an unauthenticated request never reaches the database', async () => {
    await request(app).get('/expenses')
    expect(prisma.expense.findMany).not.toHaveBeenCalled()
  })
})

describe('GET /expenses', () => {
  test('scopes the query to the signed-in user', async () => {
    mockUserId = ALICE
    prisma.expense.findMany.mockResolvedValue([expenseRow])

    const res = await request(app).get('/expenses')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([expenseRow])
    // The whole point of the file: the userId filter is present, and it's the
    // caller's own id. Drop `where` from the handler and this test fails.
    expect(prisma.expense.findMany).toHaveBeenCalledWith({
      where: { userId: ALICE },
      orderBy: { date: 'desc' },
    })
  })

  test('a different user gets a query scoped to THEIR id', async () => {
    mockUserId = BOB
    prisma.expense.findMany.mockResolvedValue([])

    await request(app).get('/expenses')

    // Pins down that the id is read per-request from the caller, not captured
    // once at startup or shared between requests.
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: BOB } })
    )
  })

  test('returns 500 when the database query fails', async () => {
    mockUserId = ALICE
    prisma.expense.findMany.mockRejectedValue(new Error('connection reset'))

    const res = await request(app).get('/expenses')

    expect(res.status).toBe(500)
  })
})

describe('POST /expenses', () => {
  test('creates the expense against the signed-in user and returns 201', async () => {
    mockUserId = ALICE
    prisma.expense.create.mockResolvedValue(expenseRow)

    const res = await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount: 650, date: '2026-06-18' })

    expect(res.status).toBe(201)
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: {
        description: 'Coffee',
        amount: 650,
        category: 'Food & Drink', // from the AI call
        date: '2026-06-18',
        userId: ALICE,
      },
    })
  })

  // A client that sends its own userId must not be able to write a row into
  // someone else's account. The handler destructures only the four allowed
  // fields out of req.body, so the extra one is dropped — this locks that in.
  test('ignores a client-supplied userId', async () => {
    mockUserId = BOB
    prisma.expense.create.mockResolvedValue(expenseRow)

    await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount: 650, date: '2026-06-18', userId: ALICE })

    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: BOB }),
    })
  })

  test('rejects a request missing required fields before doing any work', async () => {
    mockUserId = ALICE

    const res = await request(app).post('/expenses').send({ description: 'Coffee' })

    expect(res.status).toBe(400)
    // Validation runs first, so a rejected request costs neither an API call
    // nor a database round trip.
    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(prisma.expense.create).not.toHaveBeenCalled()
  })

  // The documented degraded path: Anthropic being down must not stop an
  // expense from being saved. It's saved with a less accurate category instead.
  test('still creates the expense when the AI call fails', async () => {
    mockUserId = ALICE
    mockAnthropicCreate.mockRejectedValue(new Error('Anthropic unavailable'))
    prisma.expense.create.mockResolvedValue(expenseRow)

    const res = await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount: 650, date: '2026-06-18' })

    expect(res.status).toBe(201)
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ category: 'Other' }),
    })
  })

  test('falls back to the client-provided category when the AI call fails', async () => {
    mockUserId = ALICE
    mockAnthropicCreate.mockRejectedValue(new Error('Anthropic unavailable'))
    prisma.expense.create.mockResolvedValue(expenseRow)

    await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount: 650, date: '2026-06-18', category: 'Transport' })

    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ category: 'Transport' }),
    })
  })
})

describe('PATCH /expenses/:id', () => {
  test('scopes the update to the signed-in user', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue(expenseRow)

    const res = await request(app).patch('/expenses/exp_1').send({ description: 'Latte' })

    expect(res.status).toBe(200)
    // id AND userId together: targeting the row and proving ownership is one
    // query, so there's no window between "find it" and "check whose it is".
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: ALICE },
      data: { description: 'Latte' },
    })
  })

  // The field whitelist, tested as the security control it is: without it a
  // client could PATCH { userId } and move someone else's row into its own
  // account (or its own row into a stranger's).
  test('refuses to update fields outside the whitelist', async () => {
    mockUserId = BOB
    prisma.expense.update.mockResolvedValue(expenseRow)

    await request(app)
      .patch('/expenses/exp_1')
      .send({ description: 'Latte', userId: ALICE, id: 'exp_999' })

    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: BOB }, // from the URL and the session, not the body
      data: { description: 'Latte' },      // userId and id did not survive
    })
  })

  // amount: 0 is falsy but legitimate. The handler checks `!== undefined`
  // rather than truthiness precisely so this works — easy to "simplify" away.
  test('applies an amount of 0', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue(expenseRow)

    await request(app).patch('/expenses/exp_1').send({ amount: 0 })

    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amount: 0 } })
    )
  })

  // P2025 is Prisma's "record to update not found". It fires both for an id
  // that doesn't exist and for one owned by someone else, and both must look
  // identical from outside — a 404 that said "exists, but not yours" would
  // confirm the existence of another user's data.
  test("returns 404 for another user's expense, not 403", async () => {
    mockUserId = BOB
    prisma.expense.update.mockRejectedValue({ code: 'P2025' })

    const res = await request(app).patch('/expenses/alice-expense-id').send({ description: 'Latte' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Expense not found' })
  })
})

describe('DELETE /expenses/:id', () => {
  test('scopes the delete to the signed-in user and returns 204', async () => {
    mockUserId = ALICE
    prisma.expense.delete.mockResolvedValue(expenseRow)

    const res = await request(app).delete('/expenses/exp_1')

    expect(res.status).toBe(204)
    expect(prisma.expense.delete).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: ALICE },
    })
  })

  test("returns 404 when deleting another user's expense", async () => {
    mockUserId = BOB
    prisma.expense.delete.mockRejectedValue({ code: 'P2025' })

    const res = await request(app).delete('/expenses/alice-expense-id')

    expect(res.status).toBe(404)
    // The ownership filter was in the query, which is what turned someone
    // else's row into a miss rather than a successful delete.
    expect(prisma.expense.delete).toHaveBeenCalledWith({
      where: { id: 'alice-expense-id', userId: BOB },
    })
  })

  test('returns 500 on an unexpected database error', async () => {
    mockUserId = ALICE
    prisma.expense.delete.mockRejectedValue(new Error('connection reset'))

    const res = await request(app).delete('/expenses/exp_1')

    expect(res.status).toBe(500)
  })
})
