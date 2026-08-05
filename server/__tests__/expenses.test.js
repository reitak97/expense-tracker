const request = require('supertest')

// Who is signed in for the current test. Read fresh on every getAuth() call,
// so a test can change it. The "mock" prefix is required by Jest.
let mockUserId = null

// Mock 1: Clerk. No API keys, no network. Injects an identity so the tests
// below can check that queries are scoped to it.
jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  getAuth: () => ({ userId: mockUserId }),
}))

// Mock 2: Prisma. These tests assert on the queries handlers build, not on
// rows that come back, so no database is needed.
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

// Mock 3: Anthropic. Not optional — POST swallows AI failures, so an unmocked
// test would pass while making a real billed call on every run.
const mockAnthropicCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }))
)

// '../app', not './app' — this file sits one directory deeper now.
const app = require('../app')

// Same object the handlers hold, thanks to Node's module cache.
const { prisma } = require('../lib/prisma')

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
  // clearAllMocks, not resetAllMocks — implementations survive, call records don't.
  jest.clearAllMocks()

  // Default to logged out, so nothing is accidentally authenticated.
  mockUserId = null

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

  // Rejected early: requireAuth ends the request before any handler runs.
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
    // Drop `where` from the handler and this fails.
    expect(prisma.expense.findMany).toHaveBeenCalledWith({
      where: { userId: ALICE },
      orderBy: { date: 'desc' },
    })
  })

  // The id comes from the caller each request, not captured once at startup.
  test('a different user gets a query scoped to THEIR id', async () => {
    mockUserId = BOB
    prisma.expense.findMany.mockResolvedValue([])

    await request(app).get('/expenses')

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

  // A client can't write into someone else's account by sending its own userId.
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
    // Validation runs first, so a rejected request costs no API call or query.
    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(prisma.expense.create).not.toHaveBeenCalled()
  })

  // Anthropic being down must not lose the expense — just the good category.
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
    // id and userId in one query — no gap between finding the row and
    // checking who owns it.
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: ALICE },
      data: { description: 'Latte' },
    })
  })

  // The whitelist is a security control: without it a client could PATCH
  // { userId } and move a row between accounts.
  test('refuses to update fields outside the whitelist', async () => {
    mockUserId = BOB
    prisma.expense.update.mockResolvedValue(expenseRow)

    await request(app)
      .patch('/expenses/exp_1')
      .send({ description: 'Latte', userId: ALICE, id: 'exp_999' })

    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: BOB }, // from the URL and session, not the body
      data: { description: 'Latte' },      // userId and id did not survive
    })
  })

  // 0 is falsy but legitimate, which is why the handler checks `!== undefined`.
  test('applies an amount of 0', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue(expenseRow)

    await request(app).patch('/expenses/exp_1').send({ amount: 0 })

    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amount: 0 } })
    )
  })

  // "Doesn't exist" and "isn't yours" must look identical from outside.
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
    // The ownership filter is what turned someone else's row into a miss.
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
