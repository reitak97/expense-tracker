// Written before lib/normalize.js exists, per CLAUDE.md's test-first rule for
// anything with a real failure mode. Normalization has two opposite ways to be
// wrong, and the tests exist to pin down which one we prefer:
//
//   under-merge: "STARBUCKS #1" and "STARBUCKS #2" hash differently, so the
//                LLM gets called twice. Costs a fraction of a cent.
//   over-merge:  "SHELL" (gas) and "SHELL FISH MARKET" collapse together, so
//                every seafood purchase gets categorized as Transport. Costs
//                the user's trust in their own data, silently.
//
// Those are not symmetric, so the rules below are deliberately conservative:
// when in doubt, leave the string alone and pay for the extra LLM call.
// DESIGN.md:128 makes the same call.

const { normalizeMerchant, hashMerchant } = require('../lib/normalize')

describe('normalizeMerchant', () => {
  // The exact example from DESIGN.md:117-120 — three raw descriptors that must
  // collapse to one cache key. If this block fails, the caching layer's whole
  // premise is broken.
  test('collapses the DESIGN.md Starbucks example to one value', () => {
    const variants = [
      'STARBUCKS #4471 SEATTLE WA',
      'STARBUCKS #0912 ANN ARBOR MI',
      'SQ *STARBUCKS 8823',
    ]
    const normalized = variants.map(normalizeMerchant)
    expect(normalized).toEqual(['starbucks', 'starbucks', 'starbucks'])
  })

  describe('payment processor prefixes', () => {
    test.each([
      ['SQ *BLUE BOTTLE', 'blue bottle'],       // Square
      ['TST* PIZZERIA', 'pizzeria'],            // Toast
      ['PAYPAL *STEAM GAMES', 'steam games'],
      ['PY *LOCAL GYM', 'local gym'],
    ])('strips %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected)
    })

    test('does not strip a bare asterisk mid-name', () => {
      // The prefix pattern is "known processor token, then asterisk". An
      // asterisk that isn't part of that shape is left alone rather than
      // guessed at.
      expect(normalizeMerchant('A*B HARDWARE')).toBe('a*b hardware')
    })
  })

  describe('store numbers and trailing location', () => {
    test('drops everything from the store number onward', () => {
      // Once a #1234 token appears, the rest of the descriptor is store/location
      // noise. This is the main rule, and it is why the Starbucks case works.
      expect(normalizeMerchant('TARGET #2841 ANN ARBOR MI')).toBe('target')
    })

    test('drops a bare trailing digit run', () => {
      expect(normalizeMerchant('WALGREENS 04412')).toBe('walgreens')
    })

    test('keeps digits that are part of the brand', () => {
      // "7-ELEVEN" and "76" are the merchant, not a store number. Leading
      // digits are never treated as location noise.
      expect(normalizeMerchant('7-ELEVEN 33812')).toBe('7-eleven')
      expect(normalizeMerchant('76 GAS STATION')).toBe('76 gas station')
    })

    test('strips a trailing US state code', () => {
      expect(normalizeMerchant('WHOLE FOODS MKT WA')).toBe('whole foods mkt')
    })

    test('does not strip a trailing two-letter word that is not a state', () => {
      // "GO" is not a state code; stripping it would be an over-merge.
      expect(normalizeMerchant('ON THE GO')).toBe('on the go')
    })
  })

  describe('whitespace and case', () => {
    test('lowercases and collapses runs of whitespace', () => {
      expect(normalizeMerchant('  COSTCO   WHOLESALE  ')).toBe('costco wholesale')
    })
  })

  describe('degenerate input', () => {
    // The worker calls this on every row of a user-supplied CSV. A blank
    // description column must not throw and take a whole batch down with it.
    test.each([
      ['', ''],
      ['   ', ''],
      [null, ''],
      [undefined, ''],
      ['#4471', ''],   // nothing but a store number
      ['SQ *', ''],    // nothing but a prefix
    ])('handles %p without throwing', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected)
    })
  })
})

describe('hashMerchant', () => {
  test('is deterministic across calls', () => {
    // The cache key must be stable across processes and restarts, which rules
    // out anything seeded per-run.
    expect(hashMerchant('starbucks')).toBe(hashMerchant('starbucks'))
  })

  test('gives different merchants different hashes', () => {
    expect(hashMerchant('starbucks')).not.toBe(hashMerchant('peets coffee'))
  })

  test('produces a fixed-length hex string', () => {
    // Fixed width matters: this value is a primary key column in MerchantCache.
    expect(hashMerchant('starbucks')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('hashes the normalized form, so raw variants share a key', () => {
    const a = hashMerchant(normalizeMerchant('STARBUCKS #4471 SEATTLE WA'))
    const b = hashMerchant(normalizeMerchant('SQ *STARBUCKS 8823'))
    expect(a).toBe(b)
  })
})
