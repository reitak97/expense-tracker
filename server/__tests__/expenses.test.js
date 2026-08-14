// Tests for the /expenses routes. Every request goes through the real Express
// app and the real handlers; only the four things the handlers talk to on the
// way out (Clerk, Prisma, Anthropic, the merchant cache) are replaced with
// fakes. So the assertions below are all of the form "given this request, what
// exactly did the handler ask the database (or the AI, or the cache) to do?"

const request = require('supertest')

// Who is signed in for the current test. Each test sets this before making a
// request, and the fake getAuth() below reads it at call time rather than
// closing over its value, so assigning to it mid-file actually takes effect.
// Jest forbids referencing outer variables inside a jest.mock() factory unless
// the name starts with "mock" — hence the prefix.
let mockUserId = null

// Mock 1 of 4: Clerk (authentication).
//
// The real Clerk SDK verifies a session token against Clerk's servers, which
// would need API keys and a network call. The fake skips all that: the
// middleware waves every request through, and getAuth() reports whoever
// mockUserId currently names. That gives each test a controllable identity,
// which is what makes assertions like "the query was scoped to ALICE"
// possible. mockUserId === null stands in for a logged-out caller.
jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  getAuth: () => ({ userId: mockUserId }),
}))

// Mock 2 of 4: Prisma (the database client).
//
// Replacing each method with jest.fn() means no Postgres instance has to be
// running, and CI needs no DATABASE_URL. The trade-off: these are not
// end-to-end tests, and nothing here proves a query returns the right rows.
// What they do prove is the part that actually carries the security
// requirement — the *arguments* the handler passes to Prisma. A jest.fn()
// records every call, so a test can say "findMany was called with exactly
// { where: { userId: ALICE }, orderBy: ... }" and fail the moment a handler
// forgets to filter by user. Handlers read the resolved value too, so tests
// that care about the response body seed one with mockResolvedValue().
jest.mock('../lib/prisma', () => ({
  prisma: {
    expense: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      delete: jest.fn(),
    },
  },
}))

// Mock 3 of 4: the Anthropic SDK (auto-categorization on POST).
//
// This one isn't just for speed. POST catches errors from the AI call and
// falls back to a default category, so a test hitting the real API would still
// pass — while quietly making a billed network request on every single run.
// The mock is what keeps that from happening. It's declared as a standalone
// jest.fn() so tests can reach it directly; the factory below wires it in as
// the `messages.create` of every `new Anthropic()` the handler constructs.
const mockAnthropicCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }))
)

// Mock 4 of 4: the merchant-override cache.
//
// When a user recategorizes an imported expense, PATCH remembers that choice
// so future imports from the same merchant land in the right category. That's
// a side effect on separate storage. The tests here only check *whether and
// with what* setOverride was called; how it persists anything is its own
// module's business, and is tested there.
jest.mock('../lib/merchantCache', () => ({
  setOverride: jest.fn(),
}))

// Imported after the jest.mock() calls above, which Jest hoists to the top of
// the file — so by the time app.js and its handlers require these modules,
// they get the fakes.
const app = require('../app')

// Node caches modules by path, so these are the very same jest.fn() objects the
// handlers call. Asserting on them here is asserting on what the handler did.
const { prisma } = require('../lib/prisma')
const { setOverride } = require('../lib/merchantCache')

// Not mocked — normalizeMerchant/hashMerchant are pure functions, and the
// override test below uses them to compute the exact value it expects.
const { normalizeMerchant, hashMerchant } = require('../lib/normalize')

// Two users, because most of what these tests check is that one can't touch
// the other's data. ALICE owns expenseRow below; BOB is the outsider.
const ALICE = 'user_alice'
const BOB = 'user_bob'

// A stand-in row for whatever the mocked Prisma "returns". Its contents mostly
// don't matter — tests spread over it when they need a specific field.
const expenseRow = {
  id: 'exp_1',
  userId: ALICE,
  description: 'Coffee',
  amount: 650,
  category: 'Food & Drink',
  date: '2026-06-18',
}

// Reset the shared state between tests so results can't leak from one into the
// next.
beforeEach(() => {
  // clearAllMocks wipes the recorded calls but keeps any implementation a mock
  // was given. resetAllMocks would also delete the implementations, which would
  // strip the Anthropic default set two lines down.
  jest.clearAllMocks()

  // Start every test logged out. A test that needs an identity has to say so,
  // which means a test can never pass by accidentally inheriting the previous
  // test's user.
  mockUserId = null

  // A plausible successful AI response, shaped like the real SDK's return
  // value, so tests not about categorization don't each have to stub one.
  // Tests that care about AI failure override it with mockRejectedValue.
  mockAnthropicCreate.mockResolvedValue({ content: [{ text: 'Food & Drink' }] })
})

// Every route sits behind requireAuth. These four confirm the guard is
// actually attached to each one — an easy thing to forget on a new endpoint.
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

  // Stronger than checking the status code. A route could return 401 *after*
  // querying — leaking data through timing, or through a log line, or through
  // whatever the next refactor does with the result. requireAuth calls
  // res.status(401) and never calls next(), so the handler never runs at all,
  // and findMany has zero recorded calls to prove it.
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
    // toHaveBeenCalledWith requires an exact match on the whole argument, so
    // deleting `where` from the handler — the bug that would serve every
    // user's expenses to everyone — fails this line rather than sliding
    // through. The mock returns Alice's row either way, which is exactly why
    // asserting on the response body alone would not catch it.
    expect(prisma.expense.findMany).toHaveBeenCalledWith({
      where: { userId: ALICE },
      orderBy: { date: 'desc' },
    })
  })

  // The same test as above with a different user, which sounds redundant but
  // isn't: it rules out a handler that reads the user id once at startup (or
  // caches it in a module-level variable) and then serves everyone the first
  // caller's data. objectContaining ignores orderBy — that's the previous
  // test's job, and this one is only about the id.
  test('a different user gets a query scoped to THEIR id', async () => {
    mockUserId = BOB
    prisma.expense.findMany.mockResolvedValue([])

    await request(app).get('/expenses')

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: BOB } })
    )
  })

  // A rejected promise from Prisma stands in for the database being down. The
  // point is that the handler catches it and answers 500, instead of leaving
  // the request hanging or crashing the process on an unhandled rejection.
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
        // Not sent in the request body. The handler asked Anthropic to
        // categorize "Coffee", and the beforeEach default answered with this.
        category: 'Food & Drink',
        date: '2026-06-18',
        // Not sent in the request body either — taken from the session.
        userId: ALICE,
      },
    })
  })

  // The request body here contains `userId: ALICE` while BOB is the one signed
  // in. If the handler spread the body into `data`, Bob could write rows into
  // Alice's account just by adding a field in the browser console. The session
  // has to win.
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

  // The POST twin of the PATCH `applies an amount of 0` test. A plain falsy
  // check rejects a legitimate zero, so the guard has to test for absence.
  test('accepts an amount of 0', async () => {
    mockUserId = ALICE
    prisma.expense.create.mockResolvedValue(expenseRow)

    const res = await request(app)
      .post('/expenses')
      .send({ description: 'Free refill', amount: 0, date: '2026-06-18' })

    expect(res.status).toBe(201)
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 0 }),
    })
  })

  // The trap on the other side of that fix. An empty form field arrives as ''
  // which is neither undefined nor null, so a guard written only against those
  // lets it through and Number('') quietly stores a $0.00 expense — a wrong
  // value saved silently, which is worse than the 400 it replaced.
  test.each([
    ['an empty string', ''],
    ['a non-numeric string', 'abc'],
    ['null', null],
  ])('rejects %s as an amount', async (_label, amount) => {
    mockUserId = ALICE

    const res = await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount, date: '2026-06-18' })

    expect(res.status).toBe(400)
    expect(prisma.expense.create).not.toHaveBeenCalled()
  })

  test('rejects a request missing required fields before doing any work', async () => {
    mockUserId = ALICE

    const res = await request(app).post('/expenses').send({ description: 'Coffee' })

    expect(res.status).toBe(400)
    // The ordering matters, not just the 400. Validation has to happen before
    // the AI call and before the insert, or a malformed request — or a flood of
    // them — costs real Anthropic spend and database work on its way to being
    // rejected anyway.
    expect(mockAnthropicCreate).not.toHaveBeenCalled()
    expect(prisma.expense.create).not.toHaveBeenCalled()
  })

  // Categorization is a convenience, not part of the write. If Anthropic is
  // down or rate-limiting, the user's expense still has to be saved; they can
  // fix the category later. Losing their input would be the worse failure.
  test('still creates the expense when the AI call fails', async () => {
    mockUserId = ALICE
    mockAnthropicCreate.mockRejectedValue(new Error('Anthropic unavailable'))
    prisma.expense.create.mockResolvedValue(expenseRow)

    const res = await request(app)
      .post('/expenses')
      .send({ description: 'Coffee', amount: 650, date: '2026-06-18' })

    expect(res.status).toBe(201)
    expect(prisma.expense.create).toHaveBeenCalledWith({
      // 'Other' is the last-resort default, used because this request sent no
      // category of its own. The next test covers the case where it did.
      data: expect.objectContaining({ category: 'Other' }),
    })
  })

  // Same AI failure as above, but the client picked a category in the form.
  // The fallback chain is: AI result, then whatever the client sent, then
  // 'Other' — so a user's explicit choice beats the generic default.
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
    // Both id and userId in a single `where`. The alternative — fetch the row,
    // compare its userId in JS, then update — has a window between the check
    // and the write, and is easy to get wrong. One query with both conditions
    // means someone else's row simply doesn't match, and there's no ownership
    // check to forget.
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'exp_1', userId: ALICE },
      data: { description: 'Latte' },
    })
  })

  // The handler copies only an explicit list of fields (description, amount,
  // category, date) out of the body. That list is a security control, not
  // tidiness: without it, PATCHing { userId: ALICE } would hand Bob's row to
  // Alice, and { id } would let the body target a different row than the URL
  // does. This request sends both of those attacks at once.
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

  // A regression guard for a specific bug. The obvious way to build the update
  // object is `if (req.body[field])`, which silently drops an amount of 0
  // because 0 is falsy — the user's edit appears to succeed and nothing
  // changes. The handler checks `!== undefined` instead, and this test is what
  // stops someone from "simplifying" it back.
  test('applies an amount of 0', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue(expenseRow)

    await request(app).patch('/expenses/exp_1').send({ amount: 0 })

    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amount: 0 } })
    )
  })

  // The learning path. When a user fixes the category on a row that came from
  // a CSV import, the handler saves that decision keyed by the merchant, so
  // the next import of "WALMART #1234 ANN ARBOR MI" is categorized correctly
  // without asking. The mocked update() returns an imported-looking row
  // (importId set) because that's the flag the handler branches on. The
  // expected hash is computed with the real normalize functions rather than
  // hard-coded, so changing the normalization rules doesn't break this test
  // for the wrong reason.
  test('records a merchant override when recategorizing an imported expense', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue({
      ...expenseRow,
      description: 'WALMART #1234 ANN ARBOR MI',
      importId: 'imp_1',
      rowIndex: 47,
    })

    await request(app).patch('/expenses/exp_1').send({ category: 'Food & Drink' })

    expect(setOverride).toHaveBeenCalledWith(ALICE, {
      normalizedHash: hashMerchant(normalizeMerchant('WALMART #1234 ANN ARBOR MI')),
      normalized: 'walmart',
      category: 'Food & Drink',
    })
  })

  // The first of the two conditions that must both hold. importId: null means
  // the user typed this expense in by hand, so its description is free text
  // like "lunch with Sam" — not a merchant name. Saving that as an override
  // would fill the table with entries no future import can ever match.
  test('does not record an override for a manually-entered expense', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue({ ...expenseRow, importId: null })

    await request(app).patch('/expenses/exp_1').send({ category: 'Transport' })

    expect(setOverride).not.toHaveBeenCalled()
  })

  // The other condition. This row *is* imported, but the PATCH only edits the
  // description — the user expressed no opinion about the category, so there's
  // nothing to learn. Without this check, any edit to an imported row would
  // re-save its existing category as a deliberate override.
  test('does not record an override when the category was not changed', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue({ ...expenseRow, importId: 'imp_1' })

    await request(app).patch('/expenses/exp_1').send({ description: 'Latte' })

    expect(setOverride).not.toHaveBeenCalled()
  })

  // Same shape of argument as the AI-failure test on POST. The update already
  // committed by the time setOverride runs; the override is bookkeeping that
  // happens afterward. If it throws, the honest answer is still 200 — the
  // user's edit did happen, and reporting 500 would tell them to retry
  // something that already succeeded. mockRejectedValueOnce, not
  // mockRejectedValue, so the failure doesn't outlive this test.
  test('still returns 200 when recording the override fails', async () => {
    mockUserId = ALICE
    prisma.expense.update.mockResolvedValue({
      ...expenseRow,
      description: 'WALMART #1234',
      importId: 'imp_1',
    })
    setOverride.mockRejectedValueOnce(new Error('connection reset'))

    const res = await request(app).patch('/expenses/exp_1').send({ category: 'Food & Drink' })

    expect(res.status).toBe(200)
  })

  // P2025 is Prisma's "no record matched" error, which is what the update
  // above produces when Bob aims at Alice's row — the id exists, but the
  // userId in the `where` doesn't match, so nothing is found. The response
  // must be 404, not 403: a 403 would confirm that the row exists and belongs
  // to someone else, which is a small information leak. "Doesn't exist" and
  // "isn't yours" have to be indistinguishable from outside.
  test("returns 404 for another user's expense, not 403", async () => {
    mockUserId = BOB
    prisma.expense.update.mockRejectedValue({ code: 'P2025' })

    const res = await request(app).patch('/expenses/alice-expense-id').send({ description: 'Latte' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Expense not found' })
  })
})

// The one route that can destroy a user's whole dataset in a single call, so
// the scoping assertions matter more here than anywhere else in this file: a
// deleteMany that loses its where clause clears the table for every user, and
// nothing about the response would look different.
describe('DELETE /expenses', () => {
  test('returns 401 with no token', async () => {
    mockUserId = null

    const res = await request(app).delete('/expenses')

    expect(res.status).toBe(401)
  })

  test('an unauthenticated request never reaches the database', async () => {
    mockUserId = null

    await request(app).delete('/expenses')

    expect(prisma.expense.deleteMany).not.toHaveBeenCalled()
  })

  test('scopes the delete to the signed-in user', async () => {
    mockUserId = ALICE
    prisma.expense.deleteMany.mockResolvedValue({ count: 12 })

    await request(app).delete('/expenses')

    expect(prisma.expense.deleteMany).toHaveBeenCalledWith({ where: { userId: ALICE } })
  })

  // The filter is the entire safety mechanism, so assert it exactly rather than
  // with objectContaining — an extra or missing key here is the bug.
  test('never issues an unfiltered delete', async () => {
    mockUserId = ALICE
    prisma.expense.deleteMany.mockResolvedValue({ count: 0 })

    await request(app).delete('/expenses')

    const where = prisma.expense.deleteMany.mock.calls[0][0].where
    expect(Object.keys(where)).toEqual(['userId'])
    expect(where.userId).toBe(ALICE)
  })

  test('deletes only the requesting user"s rows', async () => {
    mockUserId = BOB
    prisma.expense.deleteMany.mockResolvedValue({ count: 3 })

    await request(app).delete('/expenses')

    expect(prisma.expense.deleteMany).toHaveBeenCalledWith({ where: { userId: BOB } })
  })

  // The count is what the UI reports back, so it has to be the real one.
  test('reports how many rows were removed', async () => {
    mockUserId = ALICE
    prisma.expense.deleteMany.mockResolvedValue({ count: 1000 })

    const res = await request(app).delete('/expenses')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 1000 })
  })

  test('reports zero when there was nothing to delete', async () => {
    mockUserId = ALICE
    prisma.expense.deleteMany.mockResolvedValue({ count: 0 })

    const res = await request(app).delete('/expenses')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 0 })
  })

  test('returns 500 when the delete fails', async () => {
    mockUserId = ALICE
    prisma.expense.deleteMany.mockRejectedValue(new Error('connection reset'))

    const res = await request(app).delete('/expenses')

    expect(res.status).toBe(500)
  })

  // Both routes exist; the bulk one must not swallow a request meant for a
  // single id, or deleting one row would wipe the account.
  test('does not intercept a delete aimed at one expense', async () => {
    mockUserId = ALICE
    prisma.expense.delete.mockResolvedValue(expenseRow)

    await request(app).delete('/expenses/exp_1')

    expect(prisma.expense.deleteMany).not.toHaveBeenCalled()
    expect(prisma.expense.delete).toHaveBeenCalled()
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
    // Checking the query as well as the status, because the mock was told to
    // reject regardless — the 404 alone would pass even if the handler had
    // sent no userId at all. This assertion is what shows the miss came from
    // the ownership filter, which is the same reason a real Postgres would
    // have refused to delete Alice's row.
    expect(prisma.expense.delete).toHaveBeenCalledWith({
      where: { id: 'alice-expense-id', userId: BOB },
    })
  })

  // The other branch of the same catch block: an error without code P2025 is a
  // real failure, not a missing row, and has to surface as 500 rather than
  // being flattened into a misleading 404.
  test('returns 500 on an unexpected database error', async () => {
    mockUserId = ALICE
    prisma.expense.delete.mockRejectedValue(new Error('connection reset'))

    const res = await request(app).delete('/expenses/exp_1')

    expect(res.status).toBe(500)
  })
})
