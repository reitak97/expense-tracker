// The LLM half of the pipeline: normalized merchant names in, categories out.
//
// One call per batch, not one per row. The cache upstream has already removed
// everything seen before, so what arrives here is only the merchants nobody has
// categorized yet — usually a handful even for a 100-row batch.

const Anthropic = require('@anthropic-ai/sdk')

const { CATEGORIES, DEFAULT_CATEGORY } = require('../lib/categories')

const anthropic = new Anthropic()

// Cheapest model that can do a fixed-vocabulary classification well. Matching
// POST /expenses, so a merchant gets the same answer either way it's entered.
const MODEL = 'claude-haiku-4-5'

// Generous because the cap counts the whole array: a batch of unknown merchants
// is ~20 tokens each, and truncation costs a redelivery.
const MAX_TOKENS = 16000

// Constrains the response shape rather than parsing it hopefully. The enum is
// what stops a category the UI can't render from reaching the database.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          merchant: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
        },
        required: ['merchant', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['categories'],
  additionalProperties: false,
}

const SYSTEM_PROMPT =
  'You categorize merchants from bank statement descriptors. ' +
  'The names have already been normalized: store numbers, locations, and payment-processor ' +
  'prefixes are stripped, so "sq *starbucks 8823" arrives as "starbucks". ' +
  'Return one entry per merchant you are given, using the merchant name exactly as provided. ' +
  'Categorize by what the business primarily sells. When a merchant is unfamiliar or could ' +
  'plausibly be several categories, use Other rather than guessing.'

/**
 * Categorizes merchants the cache has never seen.
 *
 * Throws on an unusable response so the batch redelivers — a merchant silently
 * defaulted to Other would be cached and wrong for every user thereafter.
 *
 * @param {string[]} merchants - distinct normalized names
 * @returns {Promise<Map<string, string>>} name -> category, one per input
 */
async function categorizeMerchants(merchants) {
  const results = new Map()
  if (merchants.length === 0) return results

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Categorize each of these merchants:\n${merchants.join('\n')}`,
      },
    ],
  })

  // Truncation yields valid-looking JSON with merchants missing, so it has to
  // be caught here rather than at the parse below.
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Categorization was truncated for ${merchants.length} merchants`)
  }
  if (message.stop_reason === 'refusal') {
    throw new Error('Categorization was refused')
  }

  const text = message.content.find((block) => block.type === 'text')?.text
  if (!text) {
    throw new Error('Categorization returned no text content')
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Categorization returned unparseable JSON: ${error.message}`)
  }

  // The schema guarantees the shape, so this only has to handle which
  // merchants came back — the model can still skip or invent a name.
  const returned = new Map()
  for (const entry of parsed.categories || []) {
    returned.set(entry.merchant, entry.category)
  }

  for (const merchant of merchants) {
    results.set(merchant, returned.get(merchant) || DEFAULT_CATEGORY)
  }

  return results
}

module.exports = { categorizeMerchants, MODEL }
