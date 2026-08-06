// Written before lib/merchantCache.js. The rule under test is precedence:
// a user's own correction must beat the shared cache, and must not leak to
// anyone else.

jest.mock('../lib/prisma', () => ({
  prisma: {
    merchantOverride: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    merchantCache: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
  },
}))

const { prisma } = require('../lib/prisma')
const { lookupCategories, cacheCategories, setOverride } = require('../lib/merchantCache')

const ALICE = 'user_alice'
const BOB = 'user_bob'
const WALMART = 'hash_walmart'
const STARBUCKS = 'hash_starbucks'

beforeEach(() => {
  jest.clearAllMocks()
  // Default to "nothing found" so each test opts into what exists.
  prisma.merchantOverride.findMany.mockResolvedValue([])
  prisma.merchantCache.findMany.mockResolvedValue([])
  prisma.merchantCache.updateMany.mockResolvedValue({ count: 0 })
})

describe('lookupCategories', () => {
  test('returns an empty map when nothing is known', async () => {
    const result = await lookupCategories(ALICE, [WALMART, STARBUCKS])

    expect(result.size).toBe(0)
  })

  test('returns shared cache hits', async () => {
    prisma.merchantCache.findMany.mockResolvedValue([
      { normalizedHash: STARBUCKS, category: 'Food & Drink' },
    ])

    const result = await lookupCategories(ALICE, [STARBUCKS])

    expect(result.get(STARBUCKS)).toBe('Food & Drink')
  })

  // The whole point of the override table.
  test("a user's override beats the shared cache", async () => {
    prisma.merchantCache.findMany.mockResolvedValue([
      { normalizedHash: WALMART, category: 'Shopping' },
    ])
    prisma.merchantOverride.findMany.mockResolvedValue([
      { normalizedHash: WALMART, category: 'Food & Drink' },
    ])

    const result = await lookupCategories(ALICE, [WALMART])

    expect(result.get(WALMART)).toBe('Food & Drink')
  })

  test("one user's override is scoped to that user", async () => {
    await lookupCategories(BOB, [WALMART])

    expect(prisma.merchantOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: BOB, normalizedHash: { in: [WALMART] } } })
    )
  })

  test('looks everything up in one query per table, not one per merchant', async () => {
    await lookupCategories(ALICE, [WALMART, STARBUCKS])

    expect(prisma.merchantOverride.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.merchantCache.findMany).toHaveBeenCalledTimes(1)
  })

  test('records a hit count for merchants served from the shared cache', async () => {
    prisma.merchantCache.findMany.mockResolvedValue([
      { normalizedHash: STARBUCKS, category: 'Food & Drink' },
    ])

    await lookupCategories(ALICE, [STARBUCKS])

    expect(prisma.merchantCache.updateMany).toHaveBeenCalledWith({
      where: { normalizedHash: { in: [STARBUCKS] } },
      data: { hitCount: { increment: 1 } },
    })
  })

  test('skips the hit-count write when nothing was cached', async () => {
    await lookupCategories(ALICE, [STARBUCKS])

    expect(prisma.merchantCache.updateMany).not.toHaveBeenCalled()
  })

  test('does no queries at all for an empty list', async () => {
    const result = await lookupCategories(ALICE, [])

    expect(result.size).toBe(0)
    expect(prisma.merchantOverride.findMany).not.toHaveBeenCalled()
    expect(prisma.merchantCache.findMany).not.toHaveBeenCalled()
  })
})

describe('cacheCategories', () => {
  test('writes new entries in a single query', async () => {
    const entries = [
      { normalizedHash: STARBUCKS, normalized: 'starbucks', category: 'Food & Drink' },
      { normalizedHash: WALMART, normalized: 'walmart', category: 'Shopping' },
    ]

    await cacheCategories(entries)

    expect(prisma.merchantCache.createMany).toHaveBeenCalledTimes(1)
    expect(prisma.merchantCache.createMany).toHaveBeenCalledWith({
      data: entries,
      skipDuplicates: true,
    })
  })

  // Two workers can categorize the same new merchant at the same time; the
  // second insert must be a no-op rather than an error that kills the batch.
  test('skips rows another worker already inserted', async () => {
    await cacheCategories([
      { normalizedHash: STARBUCKS, normalized: 'starbucks', category: 'Food & Drink' },
    ])

    expect(prisma.merchantCache.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
  })

  test('does nothing for an empty list', async () => {
    await cacheCategories([])

    expect(prisma.merchantCache.createMany).not.toHaveBeenCalled()
  })
})

describe('setOverride', () => {
  test('creates the override, or replaces the existing one', async () => {
    await setOverride(ALICE, {
      normalizedHash: WALMART,
      normalized: 'walmart',
      category: 'Food & Drink',
    })

    expect(prisma.merchantOverride.upsert).toHaveBeenCalledWith({
      where: { userId_normalizedHash: { userId: ALICE, normalizedHash: WALMART } },
      create: {
        userId: ALICE,
        normalizedHash: WALMART,
        normalized: 'walmart',
        category: 'Food & Drink',
      },
      update: { category: 'Food & Drink' },
    })
  })
})
