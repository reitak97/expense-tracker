// Written before worker/processBatch.js. This is the consumer half of the
// pipeline: one queue message in, transactions and row errors out.
//
// Three rules are under test, and they are the ones the design hangs on.
// A batch is not atomic — a bad row is recorded and the rest commit. Replay is
// a no-op, because the visibility timeout guarantees a batch runs more than
// once eventually. And a batch that is about to exhaust its redeliveries
// records why before the message disappears into the DLQ.

jest.mock('../lib/prisma', () => ({
  prisma: {
    expense: { createMany: jest.fn() },
    importRowError: { createMany: jest.fn(), count: jest.fn() },
    importBatch: { update: jest.fn(), groupBy: jest.fn() },
    import: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

// The cache and the LLM are exercised by their own suites; here they are seams,
// so the assertions are about which merchants reach them.
jest.mock('../lib/merchantCache', () => ({
  lookupCategories: jest.fn(),
  cacheCategories: jest.fn(),
}))

jest.mock('../worker/categorize', () => ({
  categorizeMerchants: jest.fn(),
}))

const { prisma } = require('../lib/prisma')
const { lookupCategories, cacheCategories } = require('../lib/merchantCache')
const { categorizeMerchants } = require('../worker/categorize')
const { hashMerchant } = require('../lib/normalize')
const { MAX_RECEIVE_COUNT } = require('../lib/sqs')
const { processBatch } = require('../worker/processBatch')

const ALICE = 'user_alice'

// The message body POST /imports enqueues, minus the rows.
function batchPayload(rows, overrides = {}) {
  return {
    importId: 'imp_1',
    batchId: 'batch_0',
    userId: ALICE,
    batchIndex: 0,
    rows,
    ...overrides,
  }
}

// One row in the shape chunkRows produces: absolute index plus the raw record.
function row(rowIndex, raw) {
  return { rowIndex, raw }
}

function csvRow(rowIndex, description, { date = '2026-06-18', amount = '6.50' } = {}) {
  return row(rowIndex, { date, description, amount })
}

// Pulls the data array out of whichever createMany call the test cares about.
function createManyData(mock) {
  return mock.mock.calls[0]?.[0]?.data ?? []
}

beforeEach(() => {
  jest.clearAllMocks()

  // Default: nothing cached, the LLM answers everything, one batch per import.
  lookupCategories.mockResolvedValue(new Map())
  cacheCategories.mockResolvedValue(undefined)
  categorizeMerchants.mockImplementation(async (merchants) => new Map(merchants.map((m) => [m, 'Shopping'])))

  prisma.expense.createMany.mockResolvedValue({ count: 0 })
  prisma.importRowError.createMany.mockResolvedValue({ count: 0 })
  prisma.importRowError.count.mockResolvedValue(0)
  prisma.importBatch.update.mockResolvedValue({})
  prisma.importBatch.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 1 } }])
  prisma.import.update.mockResolvedValue({})

  // The real client runs the array as one transaction; here the operations have
  // already been issued by the mocks, so awaiting them is equivalent.
  prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations))

  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('processBatch happy path', () => {
  test('writes one expense per valid row, owned by the message"s user', async () => {
    await processBatch(batchPayload([csvRow(0, 'STARBUCKS #4471 SEATTLE WA')]), { receiveCount: 1 })

    expect(createManyData(prisma.expense.createMany)).toEqual([
      expect.objectContaining({
        userId: ALICE,
        importId: 'imp_1',
        rowIndex: 0,
        description: 'STARBUCKS #4471 SEATTLE WA',
        amount: 650,
        date: '2026-06-18',
        category: 'Shopping',
      }),
    ])
  })

  // The row's position in the file, not in the batch — it is half of the key
  // that makes a replay a no-op.
  test('keeps the absolute row index from the payload', async () => {
    await processBatch(batchPayload([csvRow(317, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(createManyData(prisma.expense.createMany)[0].rowIndex).toBe(317)
  })

  test('marks the batch COMPLETED once the rows are written', async () => {
    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.importBatch.update).toHaveBeenLastCalledWith({
      where: { id: 'batch_0' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
  })

  // The count SQS reports, so a handler can tell attempt 4 from attempt 1
  // without keeping its own state.
  test('records the delivery count on the batch', async () => {
    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 3 })

    expect(prisma.importBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch_0' },
      data: expect.objectContaining({ status: 'PROCESSING', attempts: 3 }),
    })
  })
})

describe('processBatch categorization', () => {
  // The whole cost argument for the cache: a merchant already known costs no
  // LLM call at all.
  test('does not call the LLM when every merchant is cached', async () => {
    lookupCategories.mockResolvedValue(new Map([[hashMerchant('starbucks'), 'Food & Drink']]))

    await processBatch(batchPayload([csvRow(0, 'STARBUCKS #4471 SEATTLE WA')]), { receiveCount: 1 })

    expect(categorizeMerchants).not.toHaveBeenCalled()
    expect(createManyData(prisma.expense.createMany)[0].category).toBe('Food & Drink')
  })

  test('asks the LLM only for the merchants the cache missed', async () => {
    lookupCategories.mockResolvedValue(new Map([[hashMerchant('starbucks'), 'Food & Drink']]))

    await processBatch(
      batchPayload([csvRow(0, 'STARBUCKS #4471 SEATTLE WA'), csvRow(1, 'NEW MERCHANT LLC')]),
      { receiveCount: 1 }
    )

    expect(categorizeMerchants).toHaveBeenCalledWith(['new merchant llc'])
  })

  // One call per distinct merchant, not per row — the repetition in a bank
  // statement is the entire point of normalizing first.
  test('collapses repeated merchants into a single LLM entry', async () => {
    await processBatch(
      batchPayload([
        csvRow(0, 'STARBUCKS #4471 SEATTLE WA'),
        csvRow(1, 'STARBUCKS #0912 ANN ARBOR MI'),
        csvRow(2, 'SQ *STARBUCKS 8823'),
      ]),
      { receiveCount: 1 }
    )

    expect(categorizeMerchants).toHaveBeenCalledWith(['starbucks'])
  })

  test('writes new answers to the shared cache', async () => {
    categorizeMerchants.mockResolvedValue(new Map([['whole foods', 'Food & Drink']]))

    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS #123')]), { receiveCount: 1 })

    expect(cacheCategories).toHaveBeenCalledWith([
      { normalizedHash: hashMerchant('whole foods'), normalized: 'whole foods', category: 'Food & Drink' },
    ])
  })

  // Overrides are per-user, so the lookup cannot be shared across users.
  test('scopes the category lookup to the message"s user', async () => {
    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')], { userId: 'user_bob' }), {
      receiveCount: 1,
    })

    expect(lookupCategories).toHaveBeenCalledWith('user_bob', expect.any(Array))
  })

  // A description that normalizes away entirely ("###") has no merchant to look
  // up, but it is still a real transaction the user spent money on.
  test('still writes a row whose description normalizes to nothing', async () => {
    await processBatch(batchPayload([csvRow(0, '#### 0000')]), { receiveCount: 1 })

    expect(createManyData(prisma.expense.createMany)).toHaveLength(1)
    expect(createManyData(prisma.expense.createMany)[0].category).toBe('Other')
  })
})

describe('processBatch partial failure', () => {
  // The failure-modes table: a malformed row is recorded and the batch carries
  // on. If it threw instead, one bad line would drag 99 good ones to the DLQ.
  test('records a bad row and commits the good ones', async () => {
    await processBatch(
      batchPayload([
        csvRow(0, 'WHOLE FOODS'),
        csvRow(1, 'BAD DATE MERCHANT', { date: 'last tuesday' }),
        csvRow(2, 'TARGET'),
      ]),
      { receiveCount: 1 }
    )

    expect(createManyData(prisma.expense.createMany).map((e) => e.rowIndex)).toEqual([0, 2])
    expect(createManyData(prisma.importRowError.createMany)).toEqual([
      expect.objectContaining({ importId: 'imp_1', rowIndex: 1, reason: expect.stringMatching(/date/i) }),
    ])
  })

  test('keeps the original line on the error so the user can review it', async () => {
    await processBatch(batchPayload([csvRow(0, 'X', { amount: 'not a number' })]), { receiveCount: 1 })

    const error = createManyData(prisma.importRowError.createMany)[0]
    expect(JSON.parse(error.rawRow)).toEqual({ date: '2026-06-18', description: 'X', amount: 'not a number' })
  })

  test('a batch where every row fails still completes', async () => {
    await processBatch(batchPayload([csvRow(0, '', { date: 'nope' })]), { receiveCount: 1 })

    expect(prisma.importBatch.update).toHaveBeenLastCalledWith({
      where: { id: 'batch_0' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
  })

  test('rejects a row with no description', async () => {
    await processBatch(batchPayload([csvRow(0, '   ')]), { receiveCount: 1 })

    expect(createManyData(prisma.expense.createMany)).toHaveLength(0)
    expect(createManyData(prisma.importRowError.createMany)[0].reason).toMatch(/description/i)
  })

  // Amount 0 is a real charge; only an unparseable one is an error.
  test('accepts an amount of zero', async () => {
    await processBatch(batchPayload([csvRow(0, 'REFUNDED ITEM', { amount: '0.00' })]), {
      receiveCount: 1,
    })

    expect(createManyData(prisma.expense.createMany)[0].amount).toBe(0)
  })
})

describe('processBatch redelivery', () => {
  // At-least-once delivery makes this the normal case, not the exceptional one.
  // Both writes are keyed, so the second pass changes nothing.
  test('the writes are idempotent, so a replay adds nothing', async () => {
    const payload = batchPayload([csvRow(0, 'WHOLE FOODS'), csvRow(1, 'X', { amount: 'bad' })])

    await processBatch(payload, { receiveCount: 1 })
    const firstExpenses = createManyData(prisma.expense.createMany)
    const firstErrors = createManyData(prisma.importRowError.createMany)

    jest.clearAllMocks()
    prisma.expense.createMany.mockResolvedValue({ count: 0 })
    prisma.importRowError.createMany.mockResolvedValue({ count: 0 })
    prisma.importBatch.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 1 } }])
    prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations))
    lookupCategories.mockResolvedValue(new Map())
    categorizeMerchants.mockImplementation(async (m) => new Map(m.map((x) => [x, 'Shopping'])))

    await processBatch(payload, { receiveCount: 2 })

    expect(createManyData(prisma.expense.createMany)).toEqual(firstExpenses)
    expect(createManyData(prisma.importRowError.createMany)).toEqual(firstErrors)
    expect(prisma.expense.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
    expect(prisma.importRowError.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
  })

  // Deleting the message before the writes commit would trade a duplicate for a
  // loss, so the rows and the batch status have to land together.
  test('writes the rows and the batch status in one transaction', async () => {
    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3)
  })
})

describe('processBatch failure', () => {
  // Throwing is how the poller is told not to delete the message.
  test('rethrows when categorization fails', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })
    ).rejects.toThrow('Anthropic 503')

    expect(prisma.expense.createMany).not.toHaveBeenCalled()
  })

  test('rethrows when the write fails', async () => {
    prisma.$transaction.mockRejectedValue(new Error('connection reset'))

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })
    ).rejects.toThrow('connection reset')
  })

  // An early failure is transient until proven otherwise — marking the batch
  // FAILED now would show the user a dead import that is about to retry.
  test('leaves the batch PROCESSING on an early delivery', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })
    ).rejects.toThrow()

    const statuses = prisma.importBatch.update.mock.calls.map((call) => call[0].data.status)
    expect(statuses).not.toContain('FAILED')
  })

  // The last attempt is the last chance to leave a trace: after this throw the
  // message goes to the DLQ and the app never sees it again.
  test('marks the batch FAILED on the final delivery before rethrowing', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: MAX_RECEIVE_COUNT })
    ).rejects.toThrow('Anthropic 503')

    expect(prisma.importBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch_0' },
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('Anthropic 503') }),
    })
  })

  // A batch that dies for good can be the last one outstanding. If the import
  // is not settled here it stays PROCESSING forever, and the progress UI waits
  // on a batch that is already on its way to the DLQ.
  test('settles the import when the last outstanding batch dies for good', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))
    prisma.importBatch.groupBy.mockResolvedValue([{ status: 'FAILED', _count: { _all: 1 } }])
    prisma.importRowError.count.mockResolvedValue(0)

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: MAX_RECEIVE_COUNT })
    ).rejects.toThrow('Anthropic 503')

    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
  })

  test('completes the import when a failed batch was not the last one', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))
    prisma.importBatch.groupBy.mockResolvedValue([
      { status: 'COMPLETED', _count: { _all: 7 } },
      { status: 'FAILED', _count: { _all: 1 } },
    ])

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: MAX_RECEIVE_COUNT })
    ).rejects.toThrow()

    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
  })

  test('leaves the import alone when batches are still outstanding', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))
    prisma.importBatch.groupBy.mockResolvedValue([
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'PENDING', _count: { _all: 3 } },
    ])

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: MAX_RECEIVE_COUNT })
    ).rejects.toThrow()

    expect(prisma.import.update).not.toHaveBeenCalled()
  })

  // The original error is the one worth reporting; a failure to tidy up after
  // it must not replace it.
  test('still rethrows the original error when settling the import fails', async () => {
    categorizeMerchants.mockRejectedValue(new Error('Anthropic 503'))
    prisma.importBatch.groupBy.mockRejectedValue(new Error('connection reset'))

    await expect(
      processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: MAX_RECEIVE_COUNT })
    ).rejects.toThrow('Anthropic 503')
  })

  // A payload this broken will never parse into work, so it should reach the
  // DLQ rather than be retried — but it must not write anything on the way.
  test('rejects a payload with no rows array without touching the database', async () => {
    await expect(processBatch({ importId: 'imp_1', batchId: 'batch_0', userId: ALICE })).rejects.toThrow()

    expect(prisma.importBatch.update).not.toHaveBeenCalled()
    expect(prisma.expense.createMany).not.toHaveBeenCalled()
  })

  test('rejects a payload with no userId', async () => {
    const { userId: _omitted, ...withoutUser } = batchPayload([csvRow(0, 'WHOLE FOODS')])

    await expect(processBatch(withoutUser)).rejects.toThrow(/userId/i)
    expect(prisma.expense.createMany).not.toHaveBeenCalled()
  })
})

describe('processBatch import completion', () => {
  test('completes the import when its last batch lands', async () => {
    prisma.importBatch.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 4 } }])
    prisma.importRowError.count.mockResolvedValue(3)

    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ status: 'COMPLETED', failedRows: 3 }),
    })
  })

  test('leaves the import alone while other batches are outstanding', async () => {
    prisma.importBatch.groupBy.mockResolvedValue([
      { status: 'COMPLETED', _count: { _all: 1 } },
      { status: 'PENDING', _count: { _all: 3 } },
    ])

    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.import.update).not.toHaveBeenCalled()
  })

  // Counted from ImportRowError rather than accumulated, so a replayed batch
  // cannot double-count the rows it already recorded.
  test('derives failedRows from the recorded errors, not from this batch', async () => {
    prisma.importBatch.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 1 } }])
    prisma.importRowError.count.mockResolvedValue(7)

    await processBatch(batchPayload([csvRow(0, 'X', { amount: 'bad' })]), { receiveCount: 1 })

    expect(prisma.importRowError.count).toHaveBeenCalledWith({ where: { importId: 'imp_1' } })
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ failedRows: 7 }),
    })
  })

  test('fails the import when every batch failed', async () => {
    prisma.importBatch.groupBy.mockResolvedValue([{ status: 'FAILED', _count: { _all: 2 } }])

    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
  })

  // One dead batch out of eight is a partial import, not a dead one — the user
  // still gets the 7 that worked, with a failed count explaining the rest.
  test('completes an import that has some failed batches', async () => {
    prisma.importBatch.groupBy.mockResolvedValue([
      { status: 'COMPLETED', _count: { _all: 7 } },
      { status: 'FAILED', _count: { _all: 1 } },
    ])

    await processBatch(batchPayload([csvRow(0, 'WHOLE FOODS')]), { receiveCount: 1 })

    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp_1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
  })
})
