// Reduces noisy bank descriptors to a stable merchant name, so the LLM is
// called once per distinct merchant instead of once per transaction.

const crypto = require('crypto')

// Payment-processor tags banks prepend to the merchant name.
const PROCESSOR_PREFIX = /^(SQ|TST|PY|PAYPAL|SP|IN|DD|POS|PP)\s*\*\s*/

// Explicit list, not /[A-Z]{2}$/, which would eat "ON THE GO" and "IN N OUT".
const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
])

// Drops an order-id-style suffix a bank glued onto a token with no space,
// e.g. "GRUBHUB*6427" or "AMAZON.COM*QSGWL0059" arriving as one token each.
// Only when the suffix carries a digit — an all-letters suffix ("A*B") reads
// as part of the name rather than a generated id, and is left alone. Leading
// '*' ("*4471") is a different case, handled by the store-number scan below.
function stripGluedSuffix(token) {
  const starIndex = token.indexOf('*')
  if (starIndex <= 0) return token

  const suffix = token.slice(starIndex + 1)
  return /\d/.test(suffix) ? token.slice(0, starIndex) : token
}

/**
 * Reduces a raw bank descriptor to a stable, comparable merchant name.
 *
 * @param {string|null|undefined} raw - the description column from the CSV
 * @returns {string} normalized name, or '' if nothing survives
 */
function normalizeMerchant(raw) {
  // Bad data returns '' rather than throwing and killing a whole batch.
  if (typeof raw !== 'string') return ''

  let s = raw.trim().toUpperCase()

  s = s.replace(PROCESSOR_PREFIX, '')

  let tokens = s.split(/\s+/).filter(Boolean).map(stripGluedSuffix)

  // Everything from the store number onward is store/location noise. A
  // leading '#' or '*' marks one anywhere. From index 1, any token carrying a
  // digit does too — not just a bare digit run, so an alphanumeric order code
  // ("F8300") or a phone number ("877-8244858") is caught along with a plain
  // store number, while "76 GAS STATION" survives because index 0 is exempt.
  const storeNumberAt = tokens.findIndex(
    (token, i) => /^[#*]/.test(token) || (i > 0 && /\d/.test(token))
  )
  if (storeNumberAt !== -1) {
    tokens = tokens.slice(0, storeNumberAt)
  }

  // Drop a trailing state code, but never the last remaining token.
  if (tokens.length > 1 && STATE_CODES.has(tokens[tokens.length - 1])) {
    tokens.pop()
  }

  // Rejoining on single spaces also collapses the padding banks add.
  return tokens.join(' ').toLowerCase()
}

/**
 * Hashes a normalized merchant name into the MerchantCache primary key.
 *
 * @param {string} normalized - output of normalizeMerchant
 * @returns {string} 64-character lowercase hex string
 */
function hashMerchant(normalized) {
  // Fixed-width, deterministic key. Not a security choice.
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

module.exports = { normalizeMerchant, hashMerchant }
