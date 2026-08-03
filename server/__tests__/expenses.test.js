const request = require('supertest')

// Mock Clerk so tests don't need real API keys.
// clerkMiddleware becomes a no-op; getAuth returns no userId (unauthenticated).
jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  getAuth: () => ({ userId: null }),
}))

// '../app' rather than './app' — this file now sits one directory deeper.
// Requiring app.js directly (instead of index.js) is what keeps the suite
// runnable without a DATABASE_URL: index.js is where validateEnv runs.
const app = require('../app')

describe('Expense API auth guards', () => {
  test('GET /expenses with no token returns 401', async () => {
    const res = await request(app).get('/expenses')
    expect(res.status).toBe(401)
  })

  test('POST /expenses with no token returns 401', async () => {
    const res = await request(app).post('/expenses').send({ description: 'test', amount: 100, date: '2026-06-18' })
    expect(res.status).toBe(401)
  })

  test('DELETE /expenses/:id with no token returns 401', async () => {
    const res = await request(app).delete('/expenses/some-id')
    expect(res.status).toBe(401)
  })
})
