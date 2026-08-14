// One progress shape, served two ways: pushed over the WebSocket while an
// import runs, and returned by GET /imports/:id when the socket is unavailable.
// Both read the same function so the fallback can never disagree with the push.

const { prisma } = require('./prisma')

// Batches in these states are still coming back; anything else has settled.
const OUTSTANDING = ['PENDING', 'PROCESSING']

/**
 * Reads an import's current progress.
 *
 * Scoped by userId, so another user's import is indistinguishable from one that
 * does not exist.
 *
 * @param {string} userId
 * @param {string} importId
 * @returns {Promise<object|null>} null when the import is missing or not theirs
 */
async function getImportProgress(userId, importId) {
  const record = await prisma.import.findFirst({
    where: { id: importId, userId },
    select: {
      id: true,
      filename: true,
      status: true,
      totalRows: true,
      failedRows: true,
      createdAt: true,
      completedAt: true,
      batches: { select: { status: true, rowCount: true } },
    },
  })

  if (!record) return null

  const total = record.batches.length
  const outstanding = record.batches.filter((b) => OUTSTANDING.includes(b.status)).length
  const failed = record.batches.filter((b) => b.status === 'FAILED').length

  // Rows in batches that died as a unit. They are not counted in failedRows:
  // that comes from ImportRowError, and a batch that never finished wrote none.
  // Without this the UI reports every row it didn't reject as imported.
  const unprocessedRows = record.batches
    .filter((b) => b.status === 'FAILED')
    .reduce((sum, b) => sum + b.rowCount, 0)

  return {
    id: record.id,
    filename: record.filename,
    status: record.status,
    totalRows: record.totalRows,
    // Rows rejected one at a time, with a reason the user can read.
    failedRows: record.failedRows,
    // Rows lost with a whole batch, which have no per-row reason.
    unprocessedRows,
    importedRows: record.totalRows - record.failedRows - unprocessedRows,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    batches: {
      total,
      settled: total - outstanding,
      failed,
    },
    // Batches, not rows: the worker reports progress a batch at a time, so a
    // row-based percentage would sit still and then jump.
    percentComplete: total === 0 ? 0 : Math.round(((total - outstanding) / total) * 100),
  }
}

/**
 * Whether an import has stopped moving, so pushing updates for it can stop too.
 *
 * @param {{status: string}} progress
 */
function isSettled(progress) {
  return progress.status === 'COMPLETED' || progress.status === 'FAILED'
}

module.exports = { getImportProgress, isSettled }
