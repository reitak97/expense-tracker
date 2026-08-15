// Turns one queue message into transactions.
//
//   validate rows -> normalize merchants -> cache lookup -> LLM the misses
//   -> write everything in one transaction
//
// Two rules shape the whole file. A batch is not atomic: a row that fails
// validation is recorded and the rest still commit, so one bad line never costs
// the user the other ninety-nine. And every write is keyed, because the
// visibility timeout guarantees a batch runs more than once eventually.

const { prisma } = require('../lib/prisma')
const { normalizeMerchant, hashMerchant } = require('../lib/normalize')
const { lookupCategories, cacheCategories } = require('../lib/merchantCache')
const { DEFAULT_CATEGORY } = require('../lib/categories')
const { MAX_RECEIVE_COUNT } = require('../lib/sqs')
const { categorizeMerchants } = require('./categorize')
const { parseRow } = require('./parseRow')

/**
 * Splits rows into writable expenses and recorded errors.
 *
 * @param {Array<{rowIndex: number, raw: object}>} rows
 * @returns {{valid: object[], failed: object[]}}
 */
function validateRows(rows) {
  const valid = []
  const failed = []

  for (const row of rows) {
    const parsed = parseRow(row)
    if (parsed.reason) {
      // The raw record is kept verbatim so the user reviews the line they
      // uploaded rather than our interpretation of it.
      failed.push({ rowIndex: parsed.rowIndex, rawRow: JSON.stringify(row.raw ?? null), reason: parsed.reason })
      continue
    }

    // Empty when the descriptor was pure noise ("#### 0000"). Still a real
    // charge, so it is written — just uncategorizable.
    const normalized = normalizeMerchant(parsed.description)
    valid.push({
      ...parsed,
      normalized,
      normalizedHash: normalized ? hashMerchant(normalized) : null,
    })
  }

  return { valid, failed }
}

/**
 * Resolves a category for every merchant in the batch.
 *
 * @param {string} userId - whose overrides apply
 * @param {object[]} valid - output of validateRows
 * @returns {Promise<Map<string, string>>} hash -> category
 */
async function resolveCategories(userId, valid) {
  const hashes = [...new Set(valid.map((r) => r.normalizedHash).filter(Boolean))]
  const known = await lookupCategories(userId, hashes)

  // Keyed by hash so a merchant appearing on twenty rows is asked about once.
  const misses = new Map()
  for (const r of valid) {
    if (r.normalizedHash && !known.has(r.normalizedHash)) misses.set(r.normalizedHash, r.normalized)
  }

  if (misses.size === 0) return known

  const answers = await categorizeMerchants([...misses.values()])

  const entries = [...misses].map(([normalizedHash, normalized]) => ({
    normalizedHash,
    normalized,
    category: answers.get(normalized) || DEFAULT_CATEGORY,
  }))

  // Cached before the rows are written: the next batch of the same import
  // usually repeats these merchants, and a duplicate insert is a no-op anyway.
  await cacheCategories(entries)
  for (const entry of entries) known.set(entry.normalizedHash, entry.category)

  return known
}

/**
 * Settles the parent import once none of its batches are outstanding.
 *
 * Recounted rather than accumulated, so a redelivered batch cannot inflate the
 * failed-row total it already contributed to.
 */
async function finalizeImport(importId) {
  const counts = await prisma.importBatch.groupBy({
    by: ['status'],
    where: { importId },
    _count: { _all: true },
  })

  const byStatus = Object.fromEntries(counts.map((row) => [row.status, row._count._all]))
  const outstanding = (byStatus.PENDING || 0) + (byStatus.PROCESSING || 0)
  if (outstanding > 0) return

  const total = counts.reduce((sum, row) => sum + row._count._all, 0)
  const failedRows = await prisma.importRowError.count({ where: { importId } })

  // FAILED only when nothing landed. One dead batch out of eight is a partial
  // import the user can still use, with a failed count explaining the gap.
  //
  // updateMany with a status filter, so a cancelled import is not rewritten as
  // COMPLETED by whichever in-flight batch happens to finish last. The user's
  // decision outranks the worker's bookkeeping.
  await prisma.import.updateMany({
    where: { id: importId, status: { in: ['PENDING', 'PROCESSING'] } },
    data: {
      status: (byStatus.FAILED || 0) === total ? 'FAILED' : 'COMPLETED',
      failedRows,
      completedAt: new Date(),
    },
  })
}

/**
 * Processes one batch message.
 *
 * Throws to signal the poller not to delete the message; the visibility timeout
 * schedules the retry from there.
 *
 * @param {object} payload - the message body enqueued by POST /imports
 * @param {{receiveCount?: number}} meta - how many times SQS has delivered it
 */
async function processBatch(payload, { receiveCount = 1 } = {}) {
  const { importId, batchId, userId, rows } = payload || {}

  // Checked before any write: a payload this broken will never succeed, and it
  // should reach the DLQ without having half-touched the database.
  if (!importId || !batchId) throw new Error('Batch payload is missing importId or batchId')
  if (!userId) throw new Error(`Batch ${batchId} is missing userId`)
  if (!Array.isArray(rows)) throw new Error(`Batch ${batchId} is missing its rows`)

  // updateMany rather than update, so the batch can be matched on the whole
  // ownership chain instead of its id alone: this batch, in this import, owned
  // by this user. The producer builds all three from one authenticated request,
  // so they always agree today — this is what keeps that an enforced invariant
  // rather than an assumed one, and it costs no extra round trip.
  //
  // status PENDING is part of the claim for the same reason: a batch the user
  // cancelled is CANCELLED, so it fails to match and never starts. Cancelling
  // cannot remove the message from SQS, so this is where a cancelled batch
  // actually stops.
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, importId, import: { userId }, status: { in: ['PENDING', 'PROCESSING'] } },
    data: { status: 'PROCESSING', attempts: receiveCount, startedAt: new Date() },
  })

  // Nothing claimed has two very different causes, and they need opposite
  // handling: a batch that has already settled is finished business and its
  // message should be deleted, while ids that don't belong together are a real
  // fault that belongs in the DLQ. Only queried on the miss, so the happy path
  // is still one round trip.
  if (claimed.count === 0) {
    const batch = await prisma.importBatch.findFirst({
      where: { id: batchId, importId, import: { userId } },
      select: { status: true },
    })

    // Returning rather than throwing is what deletes the message. Covers a
    // cancelled batch, and also a redelivery of one that already finished —
    // reprocessing that would be a no-op thanks to the row-level idempotency
    // key, so there is nothing to gain by doing the work again.
    if (batch && batch.status !== 'PENDING' && batch.status !== 'PROCESSING') {
      console.log(`Worker: batch ${batchId} is already ${batch.status}; dropping its message`)
      return { settled: batch.status, imported: 0, failed: 0 }
    }
  }

  // Nothing matched: the ids don't belong together, or the import is gone.
  // Either way this message can never do meaningful work, so it fails here
  // without having written anything.
  if (claimed.count === 0) {
    throw new Error(`Batch ${batchId} does not belong to import ${importId} for this user`)
  }

  try {
    const { valid, failed } = validateRows(rows)
    const categories = await resolveCategories(userId, valid)

    const expenses = valid.map((r) => ({
      userId,
      importId,
      rowIndex: r.rowIndex,
      description: r.description,
      amount: r.amount,
      date: r.date,
      category: (r.normalizedHash && categories.get(r.normalizedHash)) || DEFAULT_CATEGORY,
    }))

    // One transaction, so the batch is never COMPLETED with its rows missing —
    // the poller deletes the message on the strength of this commit.
    await prisma.$transaction([
      prisma.expense.createMany({ data: expenses, skipDuplicates: true }),
      prisma.importRowError.createMany({
        data: failed.map((f) => ({ importId, ...f })),
        skipDuplicates: true,
      }),
      // By id alone is fine from here on: the claim above already proved this
      // batch belongs to this import and this user.
      prisma.importBatch.update({
        where: { id: batchId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      }),
    ])

    await finalizeImport(importId)

    return { written: expenses.length, failed: failed.length }
  } catch (error) {
    // The last delivery is the last chance to leave a trace: after this throw
    // the message moves to the DLQ and the app never sees the batch again.
    if (receiveCount >= MAX_RECEIVE_COUNT) {
      console.error(`Worker: batch ${batchId} exhausted its redeliveries:`, error.message)
      await prisma.importBatch
        .update({
          where: { id: batchId },
          data: { status: 'FAILED', error: error.message, completedAt: new Date() },
        })
        .catch((updateError) => {
          // Recording the failure failed too. Logged rather than swallowed, and
          // deliberately not rethrown — the original error is the useful one.
          console.error(`Worker: could not mark batch ${batchId} FAILED:`, updateError.message)
        })

      // A batch that dies for good can be the last one outstanding. Settling
      // the import here too is what stops the progress UI waiting on a batch
      // that is on its way to the DLQ and never coming back.
      await finalizeImport(importId).catch((finalizeError) => {
        console.error(`Worker: could not settle import ${importId}:`, finalizeError.message)
      })
    }

    throw error
  }
}

module.exports = { processBatch, validateRows, finalizeImport }
