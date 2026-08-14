// The reader behind both halves of the progress channel: the WebSocket pushes
// it and GET /imports/:id returns it, so a client that loses its connection and
// falls back to polling sees exactly what it would have been pushed.
//
// The endpoint itself is covered in imports.test.js, alongside POST /imports.
// This file is about the shape and the arithmetic.

jest.mock('../lib/prisma', () => ({
  prisma: { import: { findFirst: jest.fn() } },
}))

const { prisma } = require('../lib/prisma')
const { getImportProgress } = require('../lib/importProgress')

const ALICE = 'user_alice'
const BOB = 'user_bob'

// What the select in getImportProgress pulls back. Batches carry rowCount
// because that is the only record of how many rows a failed batch took with it.
function importRecord(batchStatuses, overrides = {}) {
  return {
    id: 'imp_1',
    filename: 'statement.csv',
    status: 'PROCESSING',
    totalRows: 400,
    failedRows: 0,
    createdAt: new Date('2026-06-18T00:00:00Z'),
    completedAt: null,
    batches: batchStatuses.map((status) => ({ status, rowCount: 100 })),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getImportProgress', () => {
  test('counts settled batches and reports a percentage', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importRecord(['COMPLETED', 'COMPLETED', 'PROCESSING', 'PENDING'])
    )

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.batches).toEqual({ total: 4, settled: 2, failed: 0 })
    expect(progress.percentComplete).toBe(50)
  })

  // A FAILED batch is never coming back, so it counts as settled — otherwise a
  // partially dead import sits at 87% forever.
  test('treats a failed batch as settled', async () => {
    prisma.import.findFirst.mockResolvedValue(importRecord(['COMPLETED', 'FAILED']))

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.batches).toEqual({ total: 2, settled: 2, failed: 1 })
    expect(progress.percentComplete).toBe(100)
  })

  test('reports zero rather than dividing by zero for an import with no batches', async () => {
    prisma.import.findFirst.mockResolvedValue(importRecord([]))

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.percentComplete).toBe(0)
  })

  // The query itself carries the ownership check; nothing downstream re-checks.
  test('scopes the lookup to the requesting user', async () => {
    prisma.import.findFirst.mockResolvedValue(null)

    await getImportProgress(BOB, 'imp_1')

    expect(prisma.import.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'imp_1', userId: BOB } })
    )
  })

  test('returns null when the import is missing or not theirs', async () => {
    prisma.import.findFirst.mockResolvedValue(null)

    await expect(getImportProgress(ALICE, 'imp_1')).resolves.toBeNull()
  })
})

// Two ways a row fails to become an expense, and they are counted separately.
// A row rejected on its own gets an ImportRowError with a reason; a row in a
// batch that died gets nothing, because the batch never ran to completion.
describe('getImportProgress row accounting', () => {
  test('counts rows lost with a failed batch as unprocessed, not imported', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importRecord(['COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED'], { status: 'COMPLETED' })
    )

    const progress = await getImportProgress(ALICE, 'imp_1')

    // The bug this replaced reported 400 of 400 imported: failedRows is 0
    // because a dead batch writes no per-row errors.
    expect(progress.unprocessedRows).toBe(100)
    expect(progress.importedRows).toBe(300)
  })

  test('keeps per-row rejections separate from a lost batch', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importRecord(['COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED'], {
        status: 'COMPLETED',
        failedRows: 12,
      })
    )

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.failedRows).toBe(12)
    expect(progress.unprocessedRows).toBe(100)
    expect(progress.importedRows).toBe(400 - 12 - 100)
  })

  test('reports every row imported when no batch failed', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importRecord(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED'], { status: 'COMPLETED' })
    )

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.unprocessedRows).toBe(0)
    expect(progress.importedRows).toBe(400)
  })

  // The final batch of a file is usually short, so summing rowCount matters
  // more than multiplying by a batch size.
  test('uses each batch"s own row count rather than assuming they are equal', async () => {
    prisma.import.findFirst.mockResolvedValue(
      importRecord(['COMPLETED', 'FAILED'], {
        status: 'COMPLETED',
        totalRows: 130,
        batches: [
          { status: 'COMPLETED', rowCount: 100 },
          { status: 'FAILED', rowCount: 30 },
        ],
      })
    )

    const progress = await getImportProgress(ALICE, 'imp_1')

    expect(progress.unprocessedRows).toBe(30)
    expect(progress.importedRows).toBe(100)
  })
})
