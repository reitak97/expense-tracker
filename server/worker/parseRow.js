// Per-row validation for a CSV batch. The API only checks the header line, so
// this is where a row is first looked at — and it must never throw: a bad row
// becomes an ImportRowError, not a failed batch.

// Bank exports date columns in one of these two shapes. Anything else is
// rejected rather than guessed at, since 03/04 is ambiguous across locales.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Normalizes a date column to the "YYYY-MM-DD" string the schema stores.
 *
 * @param {unknown} raw
 * @returns {string|null} null if unparseable
 */
function parseDate(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()

  let year, month, day
  const iso = ISO_DATE.exec(value)
  if (iso) {
    ;[, year, month, day] = iso
  } else {
    const us = US_DATE.exec(value)
    if (!us) return null
    ;[, month, day, year] = us
  }

  const y = Number(year)
  const m = Number(month)
  const d = Number(day)

  // Rejects 2026-13-01 and 2026-02-31: Date rolls those over silently, so the
  // round-trip is what catches them.
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null
  }

  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Converts an amount column to integer cents.
 *
 * Magnitude only: banks sign debits inconsistently — some export a purchase as
 * -6.50, others as 6.50 — and Expense already means money spent.
 *
 * @param {unknown} raw
 * @returns {number|null} null if unparseable
 */
function parseAmount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(Math.abs(raw) * 100) : null
  }
  if (typeof raw !== 'string') return null

  // Strips currency symbols, thousands separators, and the (1.23) some
  // exports use for a negative.
  const cleaned = raw.trim().replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null

  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null

  // Rounded, not truncated: 0.1 + 0.2 arithmetic would otherwise lose a cent.
  return Math.round(Math.abs(value) * 100)
}

/**
 * Validates one CSV row.
 *
 * @param {{rowIndex: number, raw: object}} row - as enqueued by POST /imports
 * @returns {{rowIndex: number, description: string, amount: number, date: string}
 *   | {rowIndex: number, reason: string}}
 */
function parseRow(row) {
  const { rowIndex, raw } = row

  if (!raw || typeof raw !== 'object') {
    return { rowIndex, reason: 'Row is empty or malformed.' }
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!description) {
    return { rowIndex, reason: 'Missing a description.' }
  }

  const date = parseDate(raw.date)
  if (!date) {
    return { rowIndex, reason: `Unrecognized date: "${raw.date}". Expected YYYY-MM-DD or MM/DD/YYYY.` }
  }

  const amount = parseAmount(raw.amount)
  if (amount === null) {
    return { rowIndex, reason: `Unrecognized amount: "${raw.amount}".` }
  }

  return { rowIndex, description, amount, date }
}

module.exports = { parseRow, parseDate, parseAmount }
