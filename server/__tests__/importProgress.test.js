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

// What the select in getImportProgress pulls back.
function importRecord(batchStatuses, overrides = {}) {
  return {
    id: 'imp_1',
    filename: 'statement.csv',
    status: 'PROCESSING',
    totalRows: 400,
    failedRows: 0,
    createdAt: new Date('2026-06-18T00:00:00Z'),
    completedAt: null,
    batches: batchStatuses.map((status) => ({ status })),
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
