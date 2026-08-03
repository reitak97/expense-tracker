// The four expense endpoints: GET, POST, PATCH, DELETE /expenses.
//
// These used to live directly on the `app` object in app.js. They're on a
// Router now — a mini Express app that collects related routes into one
// mountable unit. app.js mounts it with app.use(expensesRouter), and app.js's
// job shrinks to wiring (CORS, JSON parsing, auth) rather than wiring plus
// every handler in the project. As /imports and its routes get added, each
// gets its own file here instead of app.js growing without limit.

const express = require('express')

// Anthropic client for the AI categorization call in POST /expenses.
// The API key is read from process.env automatically (ANTHROPIC_API_KEY) —
// note it's only ever used here, on the backend, never shipped to the browser.
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic()

// The shared database client — see lib/prisma.js for why it lives there.
// '../../lib/prisma' walks up two directories: routes/ -> api/ -> server/.
const { prisma } = require('../../lib/prisma')
const { requireAuth } = require('../middleware/requireAuth')

// express.Router() creates the router. Same .get/.post/.patch/.delete methods
// as `app`, but nothing is live until app.js mounts it.
const router = express.Router()

// Applies to every route in this file. Each handler below can now assume
// req.userId exists — an unauthenticated request was already turned away with
// a 401 and never reaches them. This one line replaces the six-line auth block
// that was pasted into all four handlers.
router.use(requireAuth)

// --- Routes ---
// All route handlers are async because database calls take time.
// `await` pauses execution until the database responds, then continues.
// If anything throws, the catch block returns a 500 error.

// GET /expenses — fetch all expenses from the database
router.get('/expenses', async (req, res) => {
  try {
    const expenses = await prisma.expense.findMany({
      where: { userId: req.userId }, // only this user's rows — never another user's data
      orderBy: { date: 'desc' },     // newest first
    })
    res.json(expenses) // 200 status is implicit/default
  } catch (error) {
    // This catch is for database failures specifically (network blip, bad
    // query) — auth failures were already handled by requireAuth.
    console.error('GET /expenses error:', error)
    res.status(500).json({ error: 'Failed to fetch expenses' })
  }
})

// POST /expenses — insert a new expense into the database
router.post('/expenses', async (req, res) => {
  // Destructuring: pulls these four properties out of req.body into their own
  // variables. Any that weren't sent are simply undefined, which the check
  // below relies on.
  const { description, amount, category, date } = req.body

  // Validation happens BEFORE the AI call — no point spending an API call
  // categorizing a request that's going to be rejected anyway.
  if (!description || !amount || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' })
  }

  // Default to whatever category the client sent (or 'Other') so that if
  // the Anthropic call fails below, the expense still gets created instead
  // of the whole request failing over a non-essential feature.
  let aiCategory = category || 'Other'
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Categorize this expense. Reply with ONLY one of these exact words: Food & Drink, Transport, Bills, Shopping, Health, Other. Expense: ' + description }]
    })
    // message.content is an array of blocks; [0] is the model's text reply.
    aiCategory = message.content[0].text.trim()
  } catch (error) {
    // Swallowed on purpose: if Anthropic is down or the key is bad, we log
    // it but still fall through to creating the expense with aiCategory
    // still set to its 'Other'/client-provided default from above.
    //
    // Worth being precise about why this is allowed when CLAUDE.md bans silent
    // catches: it isn't silent (it logs), and the degraded outcome is a
    // correctly-saved expense with a less accurate category. The rule targets
    // the worker, where a swallowed error means a batch stuck in PENDING with
    // no signal to anyone. Different blast radius, different rule.
    console.error('Error from Anthropic API:', error)
  }

  try {
    const expense = await prisma.expense.create({
      data: {
        description,
        amount: Number(amount), // stored in cents as an Int — see schema.prisma
        category: aiCategory || 'Other',
        date,
        userId: req.userId,
      },
    })
    res.status(201).json(expense) // 201 = Created
  } catch (error) {
    res.status(500).json({ error: 'Failed to create expense' })
  }
})

// PATCH /expenses/:id — update fields of an existing expense
router.patch('/expenses/:id', async (req, res) => {
  // Whitelist which fields a client is allowed to overwrite. Without this,
  // a client could PATCH { userId: 'someone-elses-id' } and hijack the
  // row — only fields named here ever make it into the update.
  const allowed = ['description', 'amount', 'category', 'date']
  const data = {}
  allowed.forEach(field => {
    // Checking against undefined rather than falsiness on purpose: an amount
    // of 0 is falsy but is a legitimate value the user may want to set.
    if (req.body[field] !== undefined) data[field] = req.body[field]
  })

  try {
    // where: { id, userId } does double duty: it targets the right row AND
    // scopes it to this user in one query — if the id exists but belongs
    // to someone else, Prisma finds no match, same as if it didn't exist.
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId: req.userId },
      data,
    })
    res.json(expense)
  } catch (error) {
    // P2025 = Prisma's "record to update not found" code — covers both a
    // genuinely missing id and one that belongs to a different user. Both
    // return the same 404 deliberately: telling a stranger "that id exists,
    // it just isn't yours" leaks the existence of other users' data.
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to update expense' })
  }
})

// DELETE /expenses/:id — remove an expense from the database
router.delete('/expenses/:id', async (req, res) => {
  try {
    // Same ownership check as PATCH: id + userId together, so you can only
    // ever delete your own expenses.
    await prisma.expense.delete({
      where: { id: req.params.id, userId: req.userId },
    })
    res.status(204).send() // 204 = No Content: success, nothing to return
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to delete expense' })
  }
})

module.exports = { expensesRouter: router }
