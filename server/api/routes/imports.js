// POST /imports — accepts a CSV and hands it to the pipeline.
//
// Deliberately does almost nothing: the request returns as soon as the work is
// queued, because categorizing a 10,000-row file cannot finish inside an HTTP
// request. Per-row validation belongs to the worker, so one malformed line
// never costs the user the whole upload.

const express = require('express')
const multer = require('multer')
const { parse } = require('csv-parse/sync')

const { prisma } = require('../../lib/prisma')
const { sendBatchMessages } = require('../../lib/sqs')
const { requireAuth } = require('../middleware/requireAuth')

const router = express.Router()

// Rows per queue message. Small enough that a batch finishes well inside the
// visibility timeout, large enough that a big file is hundreds of messages
// rather than thousands. Also keeps the payload far under the 256KB SQS limit.
const BATCH_SIZE = 100

// The columns every bank export has to provide, whatever it calls the rest.
const REQUIRED_COLUMNS = ['date', 'description', 'amount']

// In memory, not on disk: the file is parsed and forwarded immediately, and
// the API runs on ephemeral instances with no writable volume worth using.
const upload = multer({
  storage: multer.memoryStorage(),
  // A statement larger than this is a mistake or an attack, not an import.
  limits: { fileSize: 10 * 1024 * 1024 },
})

router.use(requireAuth)

// multer signals a rejected upload by passing an error, which Express's default
// handler would turn into a bare 500. An oversized file is a client mistake and
// has to say so.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      return res.status(status).json({ error: error.message })
    }
    if (error) return next(error)
    next()
  })
}

/**
 * Parses the uploaded buffer and checks the header line.
 *
 * @param {Buffer} buffer - raw CSV bytes
 * @returns {{rows: object[]} | {error: string}}
 */
function parseCsv(buffer) {
  let records
  try {
    records = parse(buffer, {
      columns: (header) => header.map((name) => name.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
    })
  } catch (error) {
    // csv-parse throws on structural damage — an unterminated quote, a row
    // with more fields than the header. That is a bad file, not a bad row.
    return { error: `Could not parse the file as CSV: ${error.message}` }
  }

  if (records.length === 0) {
    return { error: 'The file has no data rows.' }
  }

  // Lowercased by the columns mapper above, so banks may use any casing and
  // any column order.
  const present = Object.keys(records[0])
  const missing = REQUIRED_COLUMNS.filter((name) => !present.includes(name))
  if (missing.length > 0) {
    return { error: `The file is missing required column(s): ${missing.join(', ')}.` }
  }

  return { rows: records }
}

/**
 * Splits rows into batches, tagging each with its position in the whole file.
 *
 * @param {object[]} rows - parsed CSV records, in file order
 * @returns {Array<Array<{rowIndex: number, raw: object}>>}
 */
function chunkRows(rows) {
  const batches = []
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    batches.push(
      rows.slice(offset, offset + BATCH_SIZE).map((raw, i) => ({
        // Absolute, not batch-relative: this is half of the
        // (importId, rowIndex) key that makes a redelivered batch a no-op.
        rowIndex: offset + i,
        raw,
      }))
    )
  }
  return batches
}

// Shape returned for both a new import and a replayed one, so the client can
// treat them the same and just read the status.
function importResponse(record) {
  return {
    id: record.id,
    status: record.status,
    totalRows: record.totalRows,
    batchCount: record.batches.length,
  }
}

router.post('/imports', handleUpload, async (req, res) => {
  // Client-generated and stable across retries of the same upload. Without it
  // there is no way to tell a retry from a genuine second import of the file.
  const idempotencyKey = req.get('Idempotency-Key')
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'A CSV file is required in the "file" field' })
  }

  const parsed = parseCsv(req.file.buffer)
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error })
  }

  // Fast path for the common retry. The unique constraint below is what
  // actually enforces this; the lookup just avoids the wasted write.
  const existing = await prisma.import.findUnique({
    where: { userId_idempotencyKey: { userId: req.userId, idempotencyKey } },
    include: { batches: true },
  })
  if (existing) {
    return res.status(200).json(importResponse(existing))
  }

  const batches = chunkRows(parsed.rows)

  let created
  try {
    // Nested create, so the import and its batches commit together. An import
    // with no batch rows would be a job nothing ever picks up.
    created = await prisma.import.create({
      data: {
        userId: req.userId,
        idempotencyKey,
        filename: req.file.originalname,
        totalRows: parsed.rows.length,
        batches: {
          create: batches.map((rows, batchIndex) => ({
            batchIndex,
            rowCount: rows.length,
          })),
        },
      },
      include: { batches: true },
    })
  } catch (error) {
    // P2002 = unique violation on (userId, idempotencyKey). Two concurrent
    // uploads of the same key both cleared the check above; this one lost, so
    // return the winner rather than erroring.
    if (error.code === 'P2002') {
      const winner = await prisma.import.findUnique({
        where: { userId_idempotencyKey: { userId: req.userId, idempotencyKey } },
        include: { batches: true },
      })
      if (winner) return res.status(200).json(importResponse(winner))
    }

    console.error('POST /imports failed to create import:', error)
    return res.status(500).json({ error: 'Failed to create import' })
  }

  // Enqueued only after the commit: a crash here leaves a visible PENDING
  // import, whereas enqueuing first could put a message on the queue pointing
  // at an import row that was never written.
  const ordered = [...created.batches].sort((a, b) => a.batchIndex - b.batchIndex)
  let result
  try {
    result = await sendBatchMessages(
      ordered.map((batch) => ({
        importId: created.id,
        batchId: batch.id,
        userId: req.userId,
        batchIndex: batch.batchIndex,
        // The rows travel in the message, so a redelivery replays the identical
        // payload and the worker needs no second trip to Postgres.
        rows: batches[batch.batchIndex],
      }))
    )
  } catch (error) {
    console.error('POST /imports failed to enqueue batches:', error)
    await prisma.import.update({ where: { id: created.id }, data: { status: 'FAILED' } })
    return res.status(502).json({ error: 'Failed to queue the import for processing' })
  }

  // sendBatchMessages resolves even when individual entries are rejected, so a
  // partial failure arrives here rather than as a throw.
  if (result.failed.length > 0) {
    // A batch that never reached SQS is never coming back. Marking it FAILED
    // is what keeps the import from sitting at PENDING forever with no signal.
    const failedIds = result.failed.map(({ index }) => ordered[index].id)
    await prisma.importBatch.updateMany({
      where: { id: { in: failedIds } },
      data: { status: 'FAILED' },
    })

    if (result.sent === 0) {
      await prisma.import.update({ where: { id: created.id }, data: { status: 'FAILED' } })
      return res.status(502).json({ error: 'Failed to queue the import for processing' })
    }
  }

  // 202, not 201: the import row exists but the work it describes has not run.
  res.status(202).json(importResponse(created))
})

module.exports = { importsRouter: router, BATCH_SIZE }
