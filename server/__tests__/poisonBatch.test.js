// The DLQ path, end to end: the real poller driving the real processBatch.
//
// A poison batch is one that fails the same way every time — a payload that
// will never parse into work, or work that references rows that no longer
// exist. Retrying it is pure cost, so the queue has to stop eventually. SQS is
// what stops it: after maxReceiveCount deliveries the redrive policy moves the
// message to the DLQ rather than making it visible again.
//
// No unit test can observe that move, because it happens inside SQS. What is
// testable, and what this file covers, is our half of the contract: never
// delete a message we did not finish, never let one poison batch take the rest
// of the window with it, and leave a record behind on the last delivery — after
// which the message is gone and the ImportBatch row is the only trace left.

jest.mock('../lib/sqs', () => {
  // Re-exported rather than hardcoded so the test tracks the redrive policy.
  const { MAX_RECEIVE_COUNT } = jest.requireActual('../lib/sqs')
  return { receiveMessages: jest.fn(), deleteMessage: jest.fn(), MAX_RECEIVE_COUNT }
})

// Only the queue, the LLM, and the database are faked — the cache layer is the
// real one, so the path a message actually takes is the path under test.
jest.mock('../lib/prisma', () => ({
  prisma: {
    expense: { createMany: jest.fn() },
    importRowError: { createMany: jest.fn(), count: jest.fn() },
    importBatch: { update: jest.fn(), groupBy: jest.fn() },
    import: { update: jest.fn() },
    merchantOverride: { findMany: jest.fn() },
    merchantCache: { findMany: jest.fn(), updateMany: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('../worker/categorize', () => ({ categorizeMerchants: jest.fn() }))

const { receiveMessages, deleteMessage, MAX_RECEIVE_COUNT } = require('../lib/sqs')
const { prisma } = require('../lib/prisma')
const { categorizeMerchants } = require('../worker/categorize')
const { pollOnce } = require('../worker/poller')
const { processBatch } = require('../worker/processBatch')

const ALICE = 'user_alice'

function sqsMessage(payload, { receiptHandle = 'rh_1', receiveCount = 1 } = {}) {
  return {
    MessageId: 'msg_1',
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify(payload),
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
  }
}

function goodBatch(overrides = {}) {
  return {
    importId: 'imp_1',
    batchId: 'batch_0',
    userId: ALICE,
    batchIndex: 0,
    rows: [{ rowIndex: 0, raw: { date: '2026-06-18', description: 'WHOLE FOODS', amount: '6.50' } }],
    ...overrides,
  }
}

// Statuses that actually committed, in order — see the lazy update mock below.
let committedStatuses

function batchStatuses() {
  return committedStatuses
}

beforeEach(() => {
  jest.clearAllMocks()
  committedStatuses = []

  deleteMessage.mockResolvedValue(undefined)
  categorizeMerchants.mockImplementation(async (merchants) => new Map(merchants.map((m) => [m, 'Shopping'])))

  prisma.expense.createMany.mockResolvedValue({ count: 1 })
  prisma.importRowError.createMany.mockResolvedValue({ count: 0 })
  prisma.importRowError.count.mockResolvedValue(0)

  // Prisma's client methods return a lazy PrismaPromise: handing one to
  // $transaction does not run it, and a transaction that rolls back never does.
  // Recording on await rather than on call mirrors that, so an assertion here
  // is about what committed, not about what was merely built.
  prisma.importBatch.update.mockImplementation((args) => ({
    then: (resolve, reject) => {
      committedStatuses.push(args.data.status)
      return Promise.resolve({}).then(resolve, reject)
    },
  }))

  prisma.importBatch.groupBy.mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 1 } }])
  prisma.import.update.mockResolvedValue({})

  // Cold cache, so every batch reaches the LLM seam above.
  prisma.merchantOverride.findMany.mockResolvedValue([])
  prisma.merchantCache.findMany.mockResolvedValue([])
  prisma.merchantCache.updateMany.mockResolvedValue({ count: 0 })
  prisma.merchantCache.createMany.mockResolvedValue({ count: 0 })

  prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations))

  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('a batch whose work fails deterministically', () => {
  // The import row was deleted while its batches were still queued, so every
  // insert violates the foreign key. No number of retries fixes that.
  beforeEach(() => {
    prisma.$transaction.mockRejectedValue(
      Object.assign(new Error('Foreign key constraint failed on the field: `importId`'), {
        code: 'P2003',
      })
    )
  })

  test('is never deleted, on any delivery', async () => {
    for (let receiveCount = 1; receiveCount <= MAX_RECEIVE_COUNT; receiveCount++) {
      receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount })])
      await pollOnce(processBatch)
    }

    // Every delivery left it on the queue, which is what carries the receive
    // count up to maxReceiveCount and hands it to the DLQ.
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  // The COMPLETED write is one of the operations inside the transaction, so a
  // rollback takes it with the rows — the row stays PROCESSING in Postgres.
  // That is the database's guarantee, not something these mocks can show, so
  // what is asserted here is the consequence: nothing downstream advances.
  test('rolls back rather than committing the batch', async () => {
    for (let receiveCount = 1; receiveCount <= MAX_RECEIVE_COUNT; receiveCount++) {
      receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount })])
      await pollOnce(processBatch)
    }

    expect(prisma.$transaction).toHaveBeenCalledTimes(MAX_RECEIVE_COUNT)
    expect(prisma.import.update).not.toHaveBeenCalled()
  })

  // The point of the whole exercise. Once the message is in the DLQ nothing in
  // the app will ever see this batch again, so the row has to say why.
  test('records the reason exactly once, on the last delivery', async () => {
    for (let receiveCount = 1; receiveCount <= MAX_RECEIVE_COUNT; receiveCount++) {
      receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount })])
      await pollOnce(processBatch)
    }

    const failures = prisma.importBatch.update.mock.calls.filter(
      (call) => call[0].data.status === 'FAILED'
    )
    expect(failures).toHaveLength(1)
    expect(failures[0][0].data.error).toMatch(/foreign key/i)
  })

  // An early failure is transient until the queue says otherwise. Recording it
  // now would show the user a dead import that is in fact about to retry.
  test('records no failure while retries remain', async () => {
    receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount: MAX_RECEIVE_COUNT - 1 })])

    await pollOnce(processBatch)

    expect(batchStatuses()).not.toContain('FAILED')
  })

  // The import stays visibly incomplete rather than flipping to COMPLETED with
  // rows missing — a stalled import the user can see beats a silent wrong one.
  test('does not complete the parent import', async () => {
    receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount: MAX_RECEIVE_COUNT })])

    await pollOnce(processBatch)

    expect(prisma.import.update).not.toHaveBeenCalled()
  })
})

describe('a structurally poison payload', () => {
  // Parses as JSON, so the poller hands it on, but it can never become work.
  const missingUser = { importId: 'imp_1', batchId: 'batch_0', rows: [] }

  test('is left for the DLQ without touching the database', async () => {
    receiveMessages.mockResolvedValue([sqsMessage(missingUser)])

    await pollOnce(processBatch)

    expect(deleteMessage).not.toHaveBeenCalled()
    expect(prisma.importBatch.update).not.toHaveBeenCalled()
    expect(prisma.expense.createMany).not.toHaveBeenCalled()
  })

  test('still writes nothing on its final delivery', async () => {
    receiveMessages.mockResolvedValue([sqsMessage(missingUser, { receiveCount: MAX_RECEIVE_COUNT })])

    await pollOnce(processBatch)

    expect(prisma.expense.createMany).not.toHaveBeenCalled()
  })
})

describe('a poison batch alongside healthy ones', () => {
  // The isolation guarantee: nine good batches must not be dragged through five
  // redeliveries because the tenth is broken.
  test('does not stop the rest of the window from committing', async () => {
    receiveMessages.mockResolvedValue([
      sqsMessage({ importId: 'imp_1', batchId: 'batch_bad' }, { receiptHandle: 'rh_bad' }),
      sqsMessage(goodBatch({ batchId: 'batch_good' }), { receiptHandle: 'rh_good' }),
    ])

    await pollOnce(processBatch)

    // Only the healthy message was deleted; the poison one stays for the DLQ.
    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage).toHaveBeenCalledWith('rh_good')
    expect(prisma.expense.createMany).toHaveBeenCalledTimes(1)
  })
})

describe('a batch that fails transiently, then succeeds', () => {
  // The case the DLQ must NOT catch: an Anthropic outage that clears. The
  // batch redelivers, works, and the message is deleted normally.
  test('commits on a later delivery and is deleted', async () => {
    categorizeMerchants.mockRejectedValueOnce(new Error('Anthropic 503'))

    receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount: 1 })])
    await pollOnce(processBatch)
    expect(deleteMessage).not.toHaveBeenCalled()

    receiveMessages.mockResolvedValue([sqsMessage(goodBatch(), { receiveCount: 2 })])
    await pollOnce(processBatch)

    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(batchStatuses()).toEqual(['PROCESSING', 'PROCESSING', 'COMPLETED'])
  })
})
