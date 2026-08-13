// Tests for POST /imports — the producer half of the ingestion pipeline.
//
// This endpoint's job is narrow on purpose: accept a CSV, reject it early if
// it's unusable, write one Import plus its ImportBatch rows, and put one
// message on the queue per batch. Categorizing rows is the worker's job, and
// per-row validation is too — the API only checks the header line, so a single
// bad row can't cost the user their whole upload.

const request = require('supertest')

// Who is signed in for the current test. See expenses.test.js for why the
// name must start with "mock" and why getAuth reads it at call time.
let mockUserId = null

jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  getAuth: () => ({ userId: mockUserId }),
}))

// Prisma is faked so no Postgres is needed; the assertions are about the
// writes the handler builds, not rows that come back.
jest.mock('../lib/prisma', () => ({
  prisma: {
    import: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    importBatch: {
      updateMany: jest.fn(),
    },
  },
}))

// The queue is mocked for the same reason the Anthropic SDK is in
// expenses.test.js: an unmocked test would hit real AWS on every run.
jest.mock('../lib/sqs', () => ({
  sendBatchMessages: jest.fn(),
}))

const app = require('../app')
const { prisma } = require('../lib/prisma')
const { sendBatchMessages } = require('../lib/sqs')
const { BATCH_SIZE } = require('../api/routes/imports')

const ALICE = 'user_alice'
const BOB = 'user_bob'
const KEY = 'idem_key_123'

// Builds a CSV body with the given number of data rows under a valid header.
function csvWithRows(count) {
  const lines = ['date,description,amount']
  for (let i = 0; i < count; i++) {
    lines.push(`2026-06-${String((i % 28) + 1).padStart(2, '0')},MERCHANT ${i},${i + 1}.50`)
  }
  return lines.join('\n')
}

// Posts a CSV as multipart/form-data, the way a browser file input would.
function upload(body, { key = KEY, filename = 'statement.csv' } = {}) {
  const req = request(app).post('/imports')
  if (key !== null) req.set('Idempotency-Key', key)
  return req.attach('file', Buffer.from(body), filename)
}

// Stands in for what prisma.import.create returns: the Import plus the batch
// rows the nested write created, which is where the queue payload gets its ids.
function createdImport({ id = 'imp_1', userId = ALICE, totalRows = 3, batchCount = 1 } = {}) {
  return {
    id,
    userId,
    idempotencyKey: KEY,
    filename: 'statement.csv',
    status: 'PENDING',
    totalRows,
    failedRows: 0,
    batches: Array.from({ length: batchCount }, (_, i) => ({
      id: `batch_${i}`,
      importId: id,
      batchIndex: i,
      rowCount: 0,
      status: 'PENDING',
    })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUserId = null

  // Default: no prior import with this key, and the queue accepts everything.
  prisma.import.findUnique.mockResolvedValue(null)
  prisma.import.findFirst.mockResolvedValue(null)
  prisma.import.create.mockResolvedValue(createdImport())
  sendBatchMessages.mockResolvedValue({ sent: 1, failed: [] })
})

describe('POST /imports auth', () => {
  test('returns 401 with no token', async () => {
    const res = await upload(csvWithRows(3))
    expect(res.status).toBe(401)
  })

  test('an unauthenticated upload is never written or enqueued', async () => {
    await upload(csvWithRows(3))
    expect(prisma.import.create).not.toHaveBeenCalled()
    expect(sendBatchMessages).not.toHaveBeenCalled()
  })
})

describe('POST /imports request validation', () => {
  // Every rejection below must cost nothing: no Import row, no queue message.
  // A malformed upload that still wrote a PENDING import would leave the
  // progress UI waiting on a batch that is never coming.
  beforeEach(() => {
    mockUserId = ALICE
  })

  test('returns 400 when the Idempotency-Key header is missing', async () => {
    const res = await upload(csvWithRows(3), { key: null })

    expect(res.status).toBe(400)
    expect(prisma.import.create).not.toHaveBeenCalled()
    expect(sendBatchMessages).not.toHaveBeenCalled()
  })

  test('returns 400 when no file is attached', async () => {
    const res = await request(app).post('/imports').set('Idempotency-Key', KEY)

    expect(res.status).toBe(400)
    expect(prisma.import.create).not.toHaveBeenCalled()
  })

  // Header validation is the one content check the API does. Everything
  // per-row is deferred to the worker so one bad line can't reject the file.
  test('returns 400 when a required column is missing', async () => {
    const res = await upload('date,description\n2026-06-18,Coffee')

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/amount/i)
    expect(prisma.import.create).not.toHaveBeenCalled()
  })

  test('returns 400 for a file with headers but no data rows', async () => {
    const res = await upload('date,description,amount\n')

    expect(res.status).toBe(400)
    expect(prisma.import.create).not.toHaveBeenCalled()
  })

  test('returns 400 for a file that is not parseable as CSV', async () => {
    const res = await upload('"unterminated,quote\nrow')

    expect(res.status).toBe(400)
    expect(prisma.import.create).not.toHaveBeenCalled()
  })

  // Rejected by multer before the buffer is ever parsed. 413 rather than the
  // bare 500 Express's default error handler would produce, so the client can
  // tell the user the file is too big instead of "something went wrong".
  test('returns 413 for a file over the size limit', async () => {
    const res = await upload('x'.repeat(11 * 1024 * 1024))

    expect(res.status).toBe(413)
    expect(prisma.import.create).not.toHaveBeenCalled()
  })

  // Column order and casing vary between banks; neither should reject a file.
  test('accepts headers in any order and any case', async () => {
    const res = await upload('Amount,DATE,Description\n6.50,2026-06-18,Coffee')

    expect(res.status).toBe(202)
    expect(prisma.import.create).toHaveBeenCalled()
  })
})

describe('POST /imports persistence', () => {
  beforeEach(() => {
    mockUserId = ALICE
  })

  test('creates a PENDING import owned by the signed-in user', async () => {
    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(202)
    expect(prisma.import.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: ALICE,
          idempotencyKey: KEY,
          filename: 'statement.csv',
          totalRows: 3,
        }),
      })
    )
  })

  // Same attack as POST /expenses: the session decides the owner, not the body.
  test('ignores a client-supplied userId', async () => {
    mockUserId = BOB

    await request(app)
      .post('/imports')
      .set('Idempotency-Key', KEY)
      .field('userId', ALICE)
      .attach('file', Buffer.from(csvWithRows(3)), 'statement.csv')

    expect(prisma.import.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: BOB }),
      })
    )
  })

  // Nested create, so the Import and its batches commit in one transaction —
  // an import with no batches would be a job nothing ever picks up.
  test('creates the batch rows in the same write as the import', async () => {
    await upload(csvWithRows(3))

    const arg = prisma.import.create.mock.calls[0][0]
    expect(arg.data.batches.create).toEqual([
      expect.objectContaining({ batchIndex: 0, rowCount: 3 }),
    ])
    expect(arg.include).toEqual({ batches: true })
  })
})

describe('POST /imports batching', () => {
  beforeEach(() => {
    mockUserId = ALICE
  })

  // The batch is the unit of retry and progress, so the split has to be exact:
  // a dropped remainder row is a transaction the user silently never gets.
  test('splits rows into batches of BATCH_SIZE with a partial final batch', async () => {
    const rowCount = BATCH_SIZE * 2 + 7
    prisma.import.create.mockResolvedValue(
      createdImport({ totalRows: rowCount, batchCount: 3 })
    )

    await upload(csvWithRows(rowCount))

    const batches = prisma.import.create.mock.calls[0][0].data.batches.create
    expect(batches).toHaveLength(3)
    expect(batches.map((b) => b.rowCount)).toEqual([BATCH_SIZE, BATCH_SIZE, 7])
    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2])
  })

  test('a row count under BATCH_SIZE produces exactly one batch', async () => {
    await upload(csvWithRows(BATCH_SIZE - 1))

    const batches = prisma.import.create.mock.calls[0][0].data.batches.create
    expect(batches).toHaveLength(1)
    expect(batches[0].rowCount).toBe(BATCH_SIZE - 1)
  })

  test('a row count exactly BATCH_SIZE produces one batch, not two', async () => {
    await upload(csvWithRows(BATCH_SIZE))

    const batches = prisma.import.create.mock.calls[0][0].data.batches.create
    expect(batches).toHaveLength(1)
  })
})

describe('POST /imports enqueue', () => {
  beforeEach(() => {
    mockUserId = ALICE
  })

  // One message per batch, carrying the rows themselves — the worker needs no
  // second trip to Postgres to find out what it is processing, and a
  // redelivered message replays with the identical payload.
  test('enqueues one message per batch, carrying that batch of rows', async () => {
    await upload(csvWithRows(3))

    expect(sendBatchMessages).toHaveBeenCalledTimes(1)
    const payloads = sendBatchMessages.mock.calls[0][0]

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        importId: 'imp_1',
        batchId: 'batch_0',
        userId: ALICE,
        batchIndex: 0,
      })
    )
    expect(payloads[0].rows).toHaveLength(3)
  })

  // rowIndex is half of the (import_id, row_index) key that makes replay a
  // no-op, so it must be the row's position in the file, not within its batch.
  test('row indexes are absolute across batches, not per batch', async () => {
    const rowCount = BATCH_SIZE + 2
    prisma.import.create.mockResolvedValue(
      createdImport({ totalRows: rowCount, batchCount: 2 })
    )

    await upload(csvWithRows(rowCount))

    const [first, second] = sendBatchMessages.mock.calls[0][0]
    expect(first.rows[0].rowIndex).toBe(0)
    expect(second.rows[0].rowIndex).toBe(BATCH_SIZE)
    expect(second.rows[1].rowIndex).toBe(BATCH_SIZE + 1)
  })

  // Committing first means a crash before enqueue leaves a visible PENDING
  // import rather than a queue message pointing at a row that does not exist.
  test('writes the import before enqueuing', async () => {
    const order = []
    prisma.import.create.mockImplementation(async () => {
      order.push('db')
      return createdImport()
    })
    sendBatchMessages.mockImplementation(async () => {
      order.push('queue')
      return { sent: 1, failed: [] }
    })

    await upload(csvWithRows(3))

    expect(order).toEqual(['db', 'queue'])
  })
})

describe('POST /imports idempotency', () => {
  beforeEach(() => {
    mockUserId = ALICE
  })

  // The whole point of the Idempotency-Key: a user who retries after a flaky
  // upload gets their existing import back, not a second copy of every row.
  test('a repeated key returns the existing import without creating another', async () => {
    prisma.import.findUnique.mockResolvedValue(createdImport({ id: 'imp_existing' }))

    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(200)
    expect(res.body.id).toBe('imp_existing')
    expect(prisma.import.create).not.toHaveBeenCalled()
    // Re-enqueuing would reprocess every row; the row-level key would make the
    // writes no-ops, but it would still burn the whole batch's worth of work.
    expect(sendBatchMessages).not.toHaveBeenCalled()
  })

  test('the existing-import lookup is scoped to the signed-in user', async () => {
    await upload(csvWithRows(3))

    expect(prisma.import.findUnique).toHaveBeenCalledWith({
      where: { userId_idempotencyKey: { userId: ALICE, idempotencyKey: KEY } },
      include: { batches: true },
    })
  })

  // The same key from two different users is two different imports — the
  // unique constraint is on the pair, so one user cannot collide with another.
  test('the same key from a different user creates its own import', async () => {
    mockUserId = BOB

    await upload(csvWithRows(3))

    expect(prisma.import.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_idempotencyKey: { userId: BOB, idempotencyKey: KEY } },
      })
    )
    expect(prisma.import.create).toHaveBeenCalled()
  })

  // Two concurrent uploads with one key both pass the findUnique check, so the
  // unique constraint is the real guard. P2002 means the other request won.
  test('a concurrent duplicate loses the race and returns the winner', async () => {
    prisma.import.create.mockRejectedValue({ code: 'P2002' })
    prisma.import.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdImport({ id: 'imp_winner' }))

    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(200)
    expect(res.body.id).toBe('imp_winner')
    expect(sendBatchMessages).not.toHaveBeenCalled()
  })
})

// The REST half of the progress channel. Same reader the socket pushes from,
// so a client that loses its connection and polls sees identical numbers.
describe('GET /imports/:id', () => {
  // What prisma returns for the progress read: the import plus its batch
  // statuses, which is where the percentage comes from.
  function importWithBatches(statuses, overrides = {}) {
    return {
      id: 'imp_1',
      filename: 'statement.csv',
      status: 'PROCESSING',
      totalRows: 300,
      failedRows: 0,
      createdAt: new Date('2026-06-18T00:00:00Z'),
      completedAt: null,
      batches: statuses.map((status) => ({ status })),
      ...overrides,
    }
  }

  beforeEach(() => {
    mockUserId = ALICE
  })

  test('returns 401 with no token', async () => {
    mockUserId = null

    const res = await request(app).get('/imports/imp_1')

    expect(res.status).toBe(401)
    expect(prisma.import.findFirst).not.toHaveBeenCalled()
  })

  test('reports how many batches have settled', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importWithBatches(['COMPLETED', 'COMPLETED', 'FAILED', 'PENDING'])
    )

    const res = await request(app).get('/imports/imp_1')

    expect(res.status).toBe(200)
    expect(res.body.batches).toEqual({ total: 4, settled: 3, failed: 1 })
    expect(res.body.percentComplete).toBe(75)
  })

  // The query has to carry userId, or the id alone would return anyone's row.
  test('scopes the lookup to the signed-in user', async () => {
    mockUserId = BOB
    prisma.import.findFirst.mockResolvedValue(importWithBatches(['COMPLETED']))

    await request(app).get('/imports/imp_1')

    expect(prisma.import.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'imp_1', userId: BOB } })
    )
  })

  // Not 403: telling someone their guess was a real id is itself a leak.
  test("returns 404 for another user's import", async () => {
    prisma.import.findFirst.mockResolvedValue(null)

    const res = await request(app).get('/imports/imp_someone_else')

    expect(res.status).toBe(404)
  })

  test('returns 404 for an import that does not exist', async () => {
    prisma.import.findFirst.mockResolvedValue(null)

    const res = await request(app).get('/imports/nope')

    expect(res.status).toBe(404)
  })

  test('reports 100 percent for a finished import', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importWithBatches(['COMPLETED', 'COMPLETED'], {
        status: 'COMPLETED',
        failedRows: 2,
        completedAt: new Date('2026-06-18T00:05:00Z'),
      })
    )

    const res = await request(app).get('/imports/imp_1')

    expect(res.body.percentComplete).toBe(100)
    expect(res.body.status).toBe('COMPLETED')
    expect(res.body.failedRows).toBe(2)
  })

  // A just-created import has batches but none settled, and the UI still needs
  // a number to render rather than a NaN.
  test('reports 0 percent before any batch settles', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importWithBatches(['PENDING', 'PENDING'], { status: 'PENDING' })
    )

    const res = await request(app).get('/imports/imp_1')

    expect(res.body.percentComplete).toBe(0)
  })

  test('returns 500 when the read fails', async () => {
    prisma.import.findFirst.mockRejectedValue(new Error('connection reset'))

    const res = await request(app).get('/imports/imp_1')

    expect(res.status).toBe(500)
  })
})

describe('POST /imports enqueue failure', () => {
  beforeEach(() => {
    mockUserId = ALICE
  })

  // A batch that never reached SQS is never coming back. Leaving it PENDING
  // would hang the import forever with no signal, which is the exact silent
  // stall the worker error-handling rule exists to prevent.
  test('marks batches FAILED when their messages do not reach the queue', async () => {
    prisma.import.create.mockResolvedValue(createdImport({ totalRows: 3, batchCount: 2 }))
    sendBatchMessages.mockResolvedValue({
      sent: 1,
      failed: [{ index: 1, reason: 'ThrottlingException: rate exceeded' }],
    })

    await upload(csvWithRows(3))

    expect(prisma.importBatch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['batch_1'] } },
      data: { status: 'FAILED' },
    })
  })

  test('fails the whole import when nothing could be enqueued', async () => {
    sendBatchMessages.mockResolvedValue({
      sent: 0,
      failed: [{ index: 0, reason: 'ThrottlingException: rate exceeded' }],
    })

    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(502)
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: { status: 'FAILED' },
    })
  })

  test('returns 502 when the queue call throws outright', async () => {
    sendBatchMessages.mockRejectedValue(new Error('network unreachable'))

    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(502)
  })

  test('returns 500 when the import row cannot be written', async () => {
    prisma.import.create.mockRejectedValue(new Error('connection reset'))

    const res = await upload(csvWithRows(3))

    expect(res.status).toBe(500)
    expect(sendBatchMessages).not.toHaveBeenCalled()
  })
})
