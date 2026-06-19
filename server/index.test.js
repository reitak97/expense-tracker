const request = require('supertest')
const app = require('./app')

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
