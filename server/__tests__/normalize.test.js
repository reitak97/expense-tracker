// Written before lib/normalize.js existed. The rules are deliberately narrow:
// under-merging costs an extra LLM call, over-merging silently miscategorizes.

const { normalizeMerchant, hashMerchant } = require('../lib/normalize')

describe('normalizeMerchant', () => {
  // The DESIGN.md example. If this fails, the caching layer has no premise.
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
      ['SQ *BLUE BOTTLE', 'blue bottle'],
      ['TST* PIZZERIA', 'pizzeria'],
      ['PAYPAL *STEAM GAMES', 'steam games'],
      ['PY *LOCAL GYM', 'local gym'],
    ])('strips %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected)
    })

    // An asterisk not preceded by a known processor token is left alone.
    test('does not strip a bare asterisk mid-name', () => {
      expect(normalizeMerchant('A*B HARDWARE')).toBe('a*b hardware')
    })
  })

  describe('store numbers and trailing location', () => {
    // The main rule, and why the Starbucks case works.
    test('drops everything from the store number onward', () => {
      expect(normalizeMerchant('TARGET #2841 ANN ARBOR MI')).toBe('target')
    })

    test('drops a bare trailing digit run', () => {
      expect(normalizeMerchant('WALGREENS 04412')).toBe('walgreens')
    })

    // Some banks mark store numbers with '*' rather than '#'.
    test('treats a leading * the same as a leading #', () => {
      expect(normalizeMerchant('STARBUCKS *4471 SEATTLE WA')).toBe('starbucks')
      expect(normalizeMerchant('TARGET *2841')).toBe('target')
    })

    test('collapses # and * variants of the same merchant', () => {
      expect(normalizeMerchant('STARBUCKS *4471 SEATTLE WA'))
        .toBe(normalizeMerchant('STARBUCKS #0912 ANN ARBOR MI'))
    })

    // Leading digits are the brand, not a store number.
    test('keeps digits that are part of the brand', () => {
      expect(normalizeMerchant('7-ELEVEN 33812')).toBe('7-eleven')
      expect(normalizeMerchant('76 GAS STATION')).toBe('76 gas station')
    })

    test('strips a trailing US state code', () => {
      expect(normalizeMerchant('WHOLE FOODS MKT WA')).toBe('whole foods mkt')
    })

    // "GO" is not a state; stripping it would be an over-merge.
    test('does not strip a trailing two-letter word that is not a state', () => {
      expect(normalizeMerchant('ON THE GO')).toBe('on the go')
    })
  })

  describe('whitespace and case', () => {
    test('lowercases and collapses runs of whitespace', () => {
      expect(normalizeMerchant('  COSTCO   WHOLESALE  ')).toBe('costco wholesale')
    })
  })

  describe('degenerate input', () => {
    // A blank description must not throw and take a batch of 100 down with it.
    test.each([
      ['', ''],
      ['   ', ''],
      [null, ''],
      [undefined, ''],
      ['#4471', ''],
      ['SQ *', ''],
    ])('handles %p without throwing', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected)
    })
  })
})

describe('hashMerchant', () => {
  // Must be stable across processes and restarts, so nothing seeded per-run.
  test('is deterministic across calls', () => {
    expect(hashMerchant('starbucks')).toBe(hashMerchant('starbucks'))
  })

  test('gives different merchants different hashes', () => {
    expect(hashMerchant('starbucks')).not.toBe(hashMerchant('peets coffee'))
  })

  // Fixed width matters: this is a primary key column.
  test('produces a fixed-length hex string', () => {
    expect(hashMerchant('starbucks')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('hashes the normalized form, so raw variants share a key', () => {
    const a = hashMerchant(normalizeMerchant('STARBUCKS #4471 SEATTLE WA'))
    const b = hashMerchant(normalizeMerchant('SQ *STARBUCKS 8823'))
    expect(a).toBe(b)
  })
})
