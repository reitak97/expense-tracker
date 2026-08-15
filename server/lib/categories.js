// The category vocabulary, shared by the single-expense endpoint and the
// worker. One list so a category the LLM returns is always one the UI renders.

// Travel and Subscriptions were added after a real statement put 40% of its
// rows in Other: hotels and flights had nowhere to go, and recurring services
// were being read as ambiguous between Bills and Shopping.
const CATEGORIES = [
  'Food & Drink',
  'Transport',
  'Travel',
  'Bills',
  'Subscriptions',
  'Shopping',
  'Health',
  'Other',
]

// What an unrecognized or missing answer becomes, rather than a null category.
const DEFAULT_CATEGORY = 'Other'

module.exports = { CATEGORIES, DEFAULT_CATEGORY }
