// Clears the shared merchant cache so the current category vocabulary is
// applied to merchants that were categorized under an older one.
//
//   node scripts/reset-merchant-cache.js            # show what would change
//   node scripts/reset-merchant-cache.js --apply    # delete the rows
//
// Why this is needed at all: MerchantCache holds the answer from whenever a
// merchant was first seen, and a cache hit never reaches the LLM. Adding Travel
// and Subscriptions to lib/categories.js therefore changed nothing for the
// merchants already in the table — `marriott hotels` keeps resolving to Other
// on every future import until its row is gone.
//
// Deletes everything rather than guessing which rows are stale. A row's
// category does not record which vocabulary produced it, so "would this have
// been categorized differently today" is not answerable from the table; the
// cost of being wrong in the other direction is one LLM call per merchant on
// the next import, which the cache then refills.
//
// MerchantOverride is deliberately untouched. Those are corrections a user made
// on purpose, they already win over the cache, and re-deriving them from a
// model is exactly what the override exists to prevent.

const { validateEnv } = require('../lib/env')

validateEnv(['DATABASE_URL'])

const { prisma } = require('../lib/prisma')
const { CATEGORIES } = require('../lib/categories')

const apply = process.argv.includes('--apply')

async function main() {
  // Grouped rather than counted so the output shows which categories are
  // actually carrying the staleness — a large Other bucket is the symptom that
  // sends someone looking for this script in the first place.
  const byCategory = await prisma.merchantCache.groupBy({
    by: ['category'],
    _count: { category: true },
    orderBy: { _count: { category: 'desc' } },
  })

  const total = byCategory.reduce((sum, row) => sum + row._count.category, 0)

  if (total === 0) {
    console.log('Merchant cache is already empty. Nothing to do.')
    return
  }

  console.log(`Merchant cache holds ${total} merchant${total === 1 ? '' : 's'}:\n`)
  for (const row of byCategory) {
    // Flagged because a category no longer in the vocabulary cannot have come
    // from the current list, which makes it the clearest evidence of drift.
    const known = CATEGORIES.includes(row.category) ? '' : '  <- not in the current vocabulary'
    console.log(`  ${String(row._count.category).padStart(5)}  ${row.category}${known}`)
  }

  const overrides = await prisma.merchantOverride.count()
  console.log(`\n${overrides} user override${overrides === 1 ? '' : 's'} will be left alone.`)

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to clear the cache.')
    return
  }

  const { count } = await prisma.merchantCache.deleteMany({})
  console.log(`\nDeleted ${count} cached merchant${count === 1 ? '' : 's'}.`)
  console.log('The next import re-categorizes them against the current vocabulary.')
}

main()
  .catch((error) => {
    console.error('Failed to reset the merchant cache:', error.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
