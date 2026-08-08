// The four expense endpoints, grouped into a Router that app.js mounts.

const express = require('express')

// Backend-only: the API key never reaches the browser.
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic()

const { prisma } = require('../../lib/prisma')
const { normalizeMerchant, hashMerchant } = require('../../lib/normalize')
const { setOverride } = require('../../lib/merchantCache')
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

  // Validate before the AI call, so a doomed request costs nothing.
  if (!description || amount === undefined || amount === null || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' })
  }

  // Fallback if the AI call fails below.
  let aiCategory = category || 'Other'
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Categorize this expense. Reply with ONLY one of these exact words: Food & Drink, Transport, Bills, Shopping, Health, Other. Expense: ' + description }]
    })
    aiCategory = message.content[0].text.trim()
  } catch (error) {
    // Logged, not rethrown: a bad category shouldn't lose the expense.
    console.error('Error from Anthropic API:', error)
  }

  try {
    const expense = await prisma.expense.create({
      data: {
        description,
        amount: Number(amount), // cents, per schema.prisma
        category: aiCategory || 'Other',
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
