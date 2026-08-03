// Loads variables from a local .env file into process.env (DATABASE_URL,
// CLERK_SECRET_KEY, ANTHROPIC_API_KEY, etc). Must run before anything below
// reads those variables — that's why it's the very first line.
require('dotenv').config()

// clerkMiddleware reads the auth token off incoming requests; getAuth pulls
// the userId back out of it inside a route handler. Clerk = auth provider,
// so this app never has to handle passwords/sessions itself.
const { clerkMiddleware, getAuth } = require('@clerk/express')
// Anthropic client for the AI categorization call in POST /expenses.
// The API key is read from process.env automatically (ANTHROPIC_API_KEY) —
// note it's only ever used here, on the backend, never shipped to the browser.
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic();


const express = require('express')
const cors = require('cors')
// The shared database client. Lives in lib/ because the worker process needs
// it too — see the comment in lib/prisma.js for why that matters.
const { prisma } = require('./lib/prisma')

// The Express application instance. Routes get attached to this below;
// index.js later calls app.listen() to actually start it.
const app = express()

// CORS: by default, browsers block a page on one origin (your Vite dev
// server / deployed frontend) from calling an API on another origin (this
// server). This explicitly allowlists the two frontends that are allowed to.
app.use(cors({ origin: ['http://localhost:5173', 'https://expense-tracker-two-pi-27.vercel.app'] }))
// Without this, req.body would be undefined on POST/PATCH — this middleware
// parses incoming JSON request bodies and attaches the result to req.body.
app.use(express.json())


// --- Routes ---
// All route handlers are now async because database calls take time.
// `await` pauses execution until the database responds, then continues.
// If anything throws, the catch block returns a 500 error.

// Runs before every route below. It doesn't block unauthenticated requests
// itself — it just inspects the request and makes getAuth(req) available.
// Each route below decides for itself whether to require a userId.
app.use(clerkMiddleware())

// GET /expenses — fetch all expenses from the database
app.get('/expenses', async (req, res) => {
  // getAuth(req) throws if Clerk can't parse the request at all (e.g. no
  // token), so this is wrapped in try/catch just to turn that throw into
  // userId staying undefined, handled uniformly by the check below.
  let userId
  try { userId = getAuth(req)?.userId } catch (_) {}
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const expenses = await prisma.expense.findMany({
      where: { userId },       // only this user's rows — never another user's data
      orderBy: { date: 'desc' }, // newest first
    })
    res.json(expenses) // 200 status is implicit/default
  } catch (error) {
    // This catch is for database failures specifically (network blip, bad
    // query) — auth failures were already handled above and returned early.
    console.error('GET /expenses error:', error)
    res.status(500).json({ error: 'Failed to fetch expenses' })
  }
})

// POST /expenses — insert a new expense into the database
app.post('/expenses', async (req, res) => {
  let userId
  try { userId = getAuth(req)?.userId } catch (_) {}
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

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
    console.error('Error from Anthropic API:', error)
  }

  try {
    const expense = await prisma.expense.create({
      data: { description, amount: Number(amount), category: aiCategory || 'Other', date, userId },
    })
    res.status(201).json(expense) // 201 = Created
  } catch (error) {
    res.status(500).json({ error: 'Failed to create expense' })
  }
})

// PATCH /expenses/:id — update fields of an existing expense
app.patch('/expenses/:id', async (req, res) => {
  let userId
  try { userId = getAuth(req)?.userId } catch (_) {}
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // Whitelist which fields a client is allowed to overwrite. Without this,
  // a client could PATCH { userId: 'someone-elses-id' } and hijack the
  // row — only fields named here ever make it into the update.
  const allowed = ['description', 'amount', 'category', 'date']
  const data = {}
  allowed.forEach(field => {
    if (req.body[field] !== undefined) data[field] = req.body[field]
  })

  try {
    // where: { id, userId } does double duty: it targets the right row AND
    // scopes it to this user in one query — if the id exists but belongs
    // to someone else, Prisma finds no match, same as if it didn't exist.
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId },
      data,
    })
    res.json(expense)
  } catch (error) {
    // P2025 = Prisma's "record to update not found" code — covers both a
    // genuinely missing id and one that belongs to a different user.
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to update expense' })
  }
})

// DELETE /expenses/:id — remove an expense from the database
app.delete('/expenses/:id', async (req, res) => {
  let userId
  try { userId = getAuth(req)?.userId } catch (_) {}
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    // Same ownership check as PATCH: id + userId together, so you can only
    // ever delete your own expenses.
    await prisma.expense.delete({
      where: { id: req.params.id, userId },
    })
    res.status(204).send() // 204 = No Content: success, nothing to return
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to delete expense' })
  }
})

// Exported (not started here) so index.js can call .listen() on it, and so
// index.test.js can import it directly for request testing without a real port.
module.exports = app