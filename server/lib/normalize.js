// Merchant normalization: turning noisy bank descriptors into a stable cache key.
//
// Bank statements describe the same merchant a dozen different ways:
//
//   STARBUCKS #4471 SEATTLE WA   ─┐
//   STARBUCKS #0912 ANN ARBOR MI ─┼─► "starbucks" ─► one cache key ─► one LLM call
//   SQ *STARBUCKS 8823           ─┘
//
// Collapsing them means the LLM is called once per distinct merchant instead of
// once per transaction. On a 10,000-row statement with heavy repetition that is
// the difference between thousands of API calls and a few hundred.
//
// THE GOVERNING TRADEOFF. There are two ways to get this wrong and they are not
// equally bad:
//
//   under-merge — two spellings of one merchant hash differently, so the LLM is
//                 called twice. Costs a fraction of a cent, and nothing else.
//   over-merge  — two genuinely different merchants collapse into one key, so
//                 one inherits the other's category. Costs correctness, silently,
//                 in a way the user may never trace back.
//
// So every rule below is deliberately narrow: it fires only on shapes that are
// unambiguously noise. When a string is ambiguous, it's left alone and we pay
// for the extra call. DESIGN.md makes the same call in its tradeoff note.

const crypto = require('crypto')

// Payment processors prepend their own tag to the merchant name. These are the
// common ones on US statements. The pattern is anchored to the start (^) and
// requires the asterisk, so an asterisk elsewhere in a name is untouched.
//
// \s* allows "TST* PIZZERIA" and "TST*PIZZERIA" — spacing varies by bank.
const PROCESSOR_PREFIX = /^(SQ|TST|PY|PAYPAL|SP|IN|DD|POS|PP)\s*\*\s*/

// Trailing US state codes ("... SEATTLE WA"). An explicit list rather than a
// generic /[A-Z]{2}$/ because plenty of merchant names legitimately end in two
// letters — "ON THE GO", "IN N OUT". Guessing there is exactly the over-merge
// this module is built to avoid.
const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
])

/**
 * Reduces a raw bank descriptor to a stable, comparable merchant name.
 *
 * @param {string|null|undefined} raw - the description column from the CSV
 * @returns {string} normalized name, or '' if nothing survives
 */
function normalizeMerchant(raw) {
  // The worker runs this over every row of a user-supplied file. A missing or
  // non-string description is bad data, not an exception — returning '' lets
  // the caller record one FAILED row instead of throwing and killing a batch
  // of 100.
  if (typeof raw !== 'string') return ''

  // Work in uppercase so the patterns above only need one case, then lowercase
  // at the very end for the returned value.
  let s = raw.trim().toUpperCase()

  // 1. Strip the processor prefix, if any.
  s = s.replace(PROCESSOR_PREFIX, '')

  // 2. Split into tokens so the positional rules below can reason about them.
  //    Filter drops the empty strings that a leading/trailing space produces.
  let tokens = s.split(/\s+/).filter(Boolean)

  // 3. Truncate at the first store-number token.
  //
  //    This is the rule doing most of the work. Once "#4471" or a bare digit
  //    run appears, everything after it is store and location noise, so the
  //    merchant name is simply everything before it.
  //
  //    The two shapes are guarded differently, and the difference matters:
  //
  //      "#4471"  — a '#' token is never part of a brand name, so it counts as
  //                 a store number anywhere, including in first position.
  //      "33812"  — a bare digit run only counts from position 1 onward, which
  //                 is what protects brands that genuinely start with digits:
  //                 "7-ELEVEN 33812" and "76 GAS STATION".
  //
  //    Collapsing these two into one rule breaks one case or the other — the
  //    test suite has an example of each.
  const storeNumberAt = tokens.findIndex(
    (token, i) => token.startsWith('#') || (i > 0 && /^\d+$/.test(token))
  )
  if (storeNumberAt !== -1) {
    tokens = tokens.slice(0, storeNumberAt)
  }

  // 4. Drop a trailing state code.
  //
  //    Only when something would survive it: "WA" alone stays "WA", because a
  //    merchant genuinely named that is likelier than a descriptor that is
  //    pure location. The set lookup keeps this from firing on "GO" or "OUT".
  if (tokens.length > 1 && STATE_CODES.has(tokens[tokens.length - 1])) {
    tokens.pop()
  }

  // 5. Rejoin with single spaces — this is also what collapses the runs of
  //    whitespace banks love to pad descriptors with — and lowercase.
  return tokens.join(' ').toLowerCase()
}

/**
 * Hashes a normalized merchant name into the MerchantCache primary key.
 *
 * @param {string} normalized - output of normalizeMerchant
 * @returns {string} 64-character lowercase hex string
 */
function hashMerchant(normalized) {
  // SHA-256 for three properties the cache key needs: deterministic across
  // processes and restarts (so the API and worker agree, today and after a
  // deploy), fixed width (it's a primary key column), and collision-resistant
  // enough that two merchants never share a row.
  //
  // Not a security decision — nothing here is secret. A shorter non-crypto
  // hash would work too; SHA-256 is chosen because it's in Node's standard
  // library with no dependency and no tuning.
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

module.exports = { normalizeMerchant, hashMerchant }
