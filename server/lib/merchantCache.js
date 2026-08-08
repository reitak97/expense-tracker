// Merchant -> category lookups, in two layers.
//
//   1. MerchantOverride — this user's own correction. Wins.
//   2. MerchantCache    — the shared default, filled in by the LLM.
//
// Anything missing from both is a cache miss and needs an LLM call. Bank rows
// carry no line items, so "walmart" can only ever get the shop's usual
// category by default — layer 1 is how one user fixes that for themselves.

const { prisma } = require('./prisma')

/**
 * Looks up categories for a set of merchant hashes.
 *
 * @param {string} userId - whose overrides to apply
 * @param {string[]} hashes - normalized merchant hashes
 * @returns {Promise<Map<string, string>>} hash -> category; missing = cache miss
 */
async function lookupCategories(userId, hashes) {
  const found = new Map()

  if (hashes.length === 0) return found

  // Two queries total, not two per merchant. A batch of 100 rows can hold 80+
  // distinct merchants, and 160 round trips would dominate the batch's runtime.
  const [overrides, cached] = await Promise.all([
    prisma.merchantOverride.findMany({
      where: { userId, normalizedHash: { in: hashes } },
      select: { normalizedHash: true, category: true },
    }),
    prisma.merchantCache.findMany({
      where: { normalizedHash: { in: hashes } },
      select: { normalizedHash: true, category: true },
    }),
  ])

  // Shared cache first, then overrides on top — later writes to a Map replace
  // earlier ones, so this ordering is what makes the override win.
  for (const row of cached) found.set(row.normalizedHash, row.category)
  for (const row of overrides) found.set(row.normalizedHash, row.category)

  // Diagnostic only: which merchants are actually carrying the cache. A row
  // the loop above overwrote was found but not served, so counting it would
  // credit the cache for work the override did. One extra query per batch, not
  // per row, and skipped entirely when nothing was served from the cache.
  const overridden = new Set(overrides.map((row) => row.normalizedHash))
  const servedFromCache = cached
    .map((row) => row.normalizedHash)
    .filter((hash) => !overridden.has(hash))

  if (servedFromCache.length > 0) {
    await prisma.merchantCache.updateMany({
      where: { normalizedHash: { in: servedFromCache } },
      data: { hitCount: { increment: 1 } },
    })
  }

  return found
}

/**
 * Stores LLM answers in the shared cache.
 *
 * @param {Array<{normalizedHash: string, normalized: string, category: string}>} entries
 */
async function cacheCategories(entries) {
  if (entries.length === 0) return

  // skipDuplicates because two workers can categorize the same new merchant at
  // the same time. The loser's insert becomes a no-op instead of an error that
  // fails an otherwise good batch.
  await prisma.merchantCache.createMany({ data: entries, skipDuplicates: true })
}

/**
 * Records a user's correction for one merchant.
 *
 * @param {string} userId
 * @param {{normalizedHash: string, normalized: string, category: string}} entry
 */
async function setOverride(userId, { normalizedHash, normalized, category }) {
  // upsert, not create — a user can correct the same merchant twice.
  // userId_normalizedHash is the name Prisma gives the composite primary key.
  await prisma.merchantOverride.upsert({
    where: { userId_normalizedHash: { userId, normalizedHash } },
    create: { userId, normalizedHash, normalized, category },
    update: { category },
  })
}

module.exports = { lookupCategories, cacheCategories, setOverride }
