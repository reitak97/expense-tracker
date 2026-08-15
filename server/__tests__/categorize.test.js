// The LLM seam. Everywhere else the categorizer is mocked out, so this is the
// only file that checks what actually gets sent and how the response is read.
//
// The theme is that a wrong category is worse than a failed batch: it gets
// written to the shared cache and served to every user from then on. So an
// unusable response throws (the batch redelivers) rather than quietly
// defaulting everything to Other.

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
)

const { categorizeMerchants } = require('../worker/categorize')
const { CATEGORIES, DEFAULT_CATEGORY } = require('../lib/categories')

// The shape the API returns under output_config.format.
function llmReply(pairs, overrides = {}) {
  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          categories: pairs.map(([merchant, category]) => ({ merchant, category })),
        }),
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('categorizeMerchants request', () => {
  // The enum is what stops a category the UI cannot render from reaching the
  // database. If someone adds a category to lib/categories.js, this is what
  // proves the model was actually told about it.
  test('constrains the response to exactly the shared category list', async () => {
    mockCreate.mockResolvedValue(llmReply([['starbucks', 'Food & Drink']]))

    await categorizeMerchants(['starbucks'])

    const schema = mockCreate.mock.calls[0][0].output_config.format.schema
    expect(schema.format ?? schema.type).toBeDefined()
    expect(schema.properties.categories.items.properties.category.enum).toEqual(CATEGORIES)
  })

  test('sends every merchant it was given, once', async () => {
    mockCreate.mockResolvedValue(
      llmReply([
        ['starbucks', 'Food & Drink'],
        ['marriott hotels', 'Travel'],
      ])
    )

    await categorizeMerchants(['starbucks', 'marriott hotels'])

    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('starbucks')
    expect(prompt).toContain('marriott hotels')
  })

  // The cache upstream has already removed everything known, so an empty list
  // means there is nothing to ask about — and asking anyway costs a call.
  test('makes no API call when nothing missed the cache', async () => {
    const result = await categorizeMerchants([])

    expect(mockCreate).not.toHaveBeenCalled()
    expect(result.size).toBe(0)
  })
})

describe('categorizeMerchants response', () => {
  test('maps each merchant to the category it was given', async () => {
    mockCreate.mockResolvedValue(
      llmReply([
        ['netflix.com', 'Subscriptions'],
        ['marriott hotels', 'Travel'],
      ])
    )

    const result = await categorizeMerchants(['netflix.com', 'marriott hotels'])

    expect(result.get('netflix.com')).toBe('Subscriptions')
    expect(result.get('marriott hotels')).toBe('Travel')
  })

  // Every input needs an answer, or the row it belongs to has no category at
  // all. A merchant the model skipped falls back rather than going missing.
  test('falls back for a merchant the model did not answer for', async () => {
    mockCreate.mockResolvedValue(llmReply([['starbucks', 'Food & Drink']]))

    const result = await categorizeMerchants(['starbucks', 'obscure llc'])

    expect(result.size).toBe(2)
    expect(result.get('obscure llc')).toBe(DEFAULT_CATEGORY)
  })

  test('ignores a merchant the model invented', async () => {
    mockCreate.mockResolvedValue(
      llmReply([
        ['starbucks', 'Food & Drink'],
        ['never asked about this', 'Shopping'],
      ])
    )

    const result = await categorizeMerchants(['starbucks'])

    expect([...result.keys()]).toEqual(['starbucks'])
  })
})

describe('categorizeMerchants failure', () => {
  // Truncation produces valid JSON with merchants missing, so it cannot be
  // caught at the parse — every one of them would silently become Other and be
  // cached that way.
  test('throws when the response was truncated', async () => {
    mockCreate.mockResolvedValue(llmReply([['starbucks', 'Food & Drink']], { stop_reason: 'max_tokens' }))

    await expect(categorizeMerchants(['starbucks'])).rejects.toThrow(/truncated/i)
  })

  test('throws when the model refused', async () => {
    mockCreate.mockResolvedValue(llmReply([], { stop_reason: 'refusal' }))

    await expect(categorizeMerchants(['starbucks'])).rejects.toThrow(/refus/i)
  })

  test('throws when the response has no text block', async () => {
    mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [] })

    await expect(categorizeMerchants(['starbucks'])).rejects.toThrow(/no text/i)
  })

  test('throws when the text is not JSON', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Food & Drink, probably' }],
    })

    await expect(categorizeMerchants(['starbucks'])).rejects.toThrow(/unparseable/i)
  })

  // Letting the API error through is the point: the batch redelivers and tries
  // again, rather than caching a guess.
  test('lets an API error propagate', async () => {
    mockCreate.mockRejectedValue(new Error('overloaded_error'))

    await expect(categorizeMerchants(['starbucks'])).rejects.toThrow('overloaded_error')
  })
})
