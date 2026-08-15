// The four expense endpoints, grouped into a Router that app.js mounts.

const express = require('express')

// Backend-only: the API key never reaches the browser.
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic()

const { prisma } = require('../../lib/prisma')
const { normalizeMerchant, hashMerchant } = require('../../lib/normalize')
const { setOverride } = require('../../lib/merchantCache')
const { CATEGORIES, DEFAULT_CATEGORY } = require('../../lib/categories')
const { requireAuth } = require('../middleware/requireAuth')

const router = express.Router()

// Applies to every route below, so each handler can assume req.userId.
router.use(requireAuth)

// GET /expenses — this user's expenses, newest first
router.get('/expenses', async (req, res) => {
  try {
    const expenses = await prisma.expense.findMany({
      where: { userId: req.userId },
      orderBy: { date: 'desc' },
    })
    res.json(expenses)
  } catch (error) {
    console.error('GET /expenses error:', error)
    res.status(500).json({ error: 'Failed to fetch expenses' })
  }
})

// POST /expenses — create one, with an AI-assigned category
router.post('/expenses', async (req, res) => {
  const { description, amount, category, date } = req.body

  // Absence, not falsiness — 0 is a legitimate amount. Empty string is checked
  // separately because Number('') is 0, so a numeric test alone would let a
  // blank form field through and save it as $0.00.
  const trimmedAmount = typeof amount === 'string' ? amount.trim() : amount
  const amountIsValid =
    trimmedAmount !== undefined &&
    trimmedAmount !== null &&
    trimmedAmount !== '' &&
    Number.isFinite(Number(trimmedAmount))

  // Validate before the AI call, so a doomed request costs nothing.
  if (!description || !amountIsValid || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' })
  }

  // Fallback if the AI call fails below.
  let aiCategory = category || DEFAULT_CATEGORY
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      // Built from the shared list rather than spelled out here. The two were
      // separate copies, so adding a category to lib/categories.js would have
      // left this endpoint offering the old vocabulary indefinitely.
      messages: [{ role: 'user', content: `Categorize this expense. Reply with ONLY one of these exact words: ${CATEGORIES.join(', ')}. Expense: ` + description }]
    })
    const answer = message.content[0].text.trim()
    // Checked against the list rather than trusted. The worker constrains its
    // answers with a response schema; this endpoint asks in prose, so nothing
    // stops "Subscription" or "Travel." coming back and being stored as a
    // category no part of the UI knows how to render.
    aiCategory = CATEGORIES.includes(answer) ? answer : DEFAULT_CATEGORY
  } catch (error) {
    // Logged, not rethrown: a bad category shouldn't lose the expense.
    console.error('Error from Anthropic API:', error)
  }

  try {
    const expense = await prisma.expense.create({
      data: {
        description,
        amount: Number(amount), // cents, per schema.prisma
        category: aiCategory || DEFAULT_CATEGORY,
        date,
        userId: req.userId,
      },
    })
    res.status(201).json(expense)
  } catch (error) {
    res.status(500).json({ error: 'Failed to create expense' })
  }
})

// PATCH /expenses/:id — update allowed fields
router.patch('/expenses/:id', async (req, res) => {
  // Whitelist, so a client can't PATCH userId and hijack the row.
  const allowed = ['description', 'amount', 'category', 'date']
  const data = {}
  allowed.forEach(field => {
    // undefined, not falsy — an amount of 0 is a legitimate value.
    if (req.body[field] !== undefined) data[field] = req.body[field]
  })

  try {
    // id + userId together: someone else's row simply doesn't match.
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId: req.userId },
      data,
    })

    // Remember the correction so future imports of this merchant get it right.
    // Imported rows only — a manual expense's description is free text like
    // "lunch with Sam", which is not a merchant and would pollute the table.
    if (data.category && expense.importId) {
      const normalized = normalizeMerchant(expense.description)
      if (normalized) {
        try {
          await setOverride(req.userId, {
            normalizedHash: hashMerchant(normalized),
            normalized,
            category: data.category,
          })
        } catch (error) {
          // The edit itself succeeded; failing to remember it is not worth
          // turning the user's successful save into a 500.
          console.error('Failed to record merchant override:', error)
        }
      }
    }

    res.json(expense)
  } catch (error) {
    // P2025 = record not found. Missing and not-yours return the same 404 on
    // purpose, so the API doesn't leak that another user's row exists.
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to update expense' })
  }
})

// DELETE /expenses — remove every expense this user has
//
// Declared before the /:id route for readability only. Order does not matter
// here because the two patterns are disjoint — `/expenses/exp_1` cannot match
// the bare path. Express matches in registration order, not literal-first, so
// a future `/expenses/summary` next to `/expenses/:id` would need the specific
// one declared first. deleteMany rather than a loop: one statement,
// and the userId filter is the whole safety story — without it this clears the
// table for everyone.
router.delete('/expenses', async (req, res) => {
  try {
    const { count } = await prisma.expense.deleteMany({ where: { userId: req.userId } })

    // Import rows are left alone. They are a record of what was uploaded and
    // when, which stays true even after the expenses are gone.
    res.json({ deleted: count })
  } catch (error) {
    console.error('DELETE /expenses error:', error)
    res.status(500).json({ error: 'Failed to delete expenses' })
  }
})

// DELETE /expenses/:id — remove one
router.delete('/expenses/:id', async (req, res) => {
  try {
    await prisma.expense.delete({
      where: { id: req.params.id, userId: req.userId },
    })
    res.status(204).send()
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to delete expense' })
  }
})

module.exports = { expensesRouter: router }
