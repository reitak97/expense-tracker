// The category vocabulary, shared by the single-expense endpoint and the
// worker. One list so a category the LLM returns is always one the UI renders.

const CATEGORIES = ['Food & Drink', 'Transport', 'Bills', 'Shopping', 'Health', 'Other']

// What an unrecognized or missing answer becomes, rather than a null category.
const DEFAULT_CATEGORY = 'Other'

module.exports = { CATEGORIES, DEFAULT_CATEGORY }
