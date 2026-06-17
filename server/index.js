require('dotenv').config()

const { clerkMiddleware, getAuth } = require('@clerk/express')
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic();


const express = require('express')
const cors = require('cors')
// Import the generated Prisma client — this is what talks to the database
const { PrismaClient } = require('@prisma/client')

const app = express()
const PORT = process.env.PORT || 3001

// One shared PrismaClient instance for the whole app.
// Creating multiple instances causes too many database connections.
const prisma = new PrismaClient()

app.use(cors({ origin: ['http://localhost:5173', 'https://expense-tracker-two-pi-27.vercel.app'] }))
app.use(express.json())


// --- Routes ---
// All route handlers are now async because database calls take time.
// `await` pauses execution until the database responds, then continues.
// If anything throws, the catch block returns a 500 error.

// GET /expenses — fetch all expenses from the database
app.use(clerkMiddleware())



app.get('/expenses', async (req, res) => {
  const userId = getAuth(req).userId
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const expenses = await prisma.expense.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
    })
    res.json(expenses)
  } catch (error) {
    console.error('GET /expenses error:', error)
    res.status(500).json({ error: 'Failed to fetch expenses' })
  }
})

// POST /expenses — insert a new expense into the database
app.post('/expenses', async (req, res) => {
  const userId = getAuth(req).userId
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { description, amount, category, date } = req.body

  if (!description || !amount || !date) {
    return res.status(400).json({ error: 'description, amount, and date are required' })
  }

  let aiCategory = category || 'Other'
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Categorize this expense. Reply with ONLY one of these exact words: Food & Drink, Transport, Bills, Shopping, Health, Other. Expense: ' + description }]
    })
    aiCategory = message.content[0].text.trim()
  } catch (error) {
    console.error('Error from Anthropic API:', error)
  }

  try {
    const expense = await prisma.expense.create({
      data: { description, amount: Number(amount), category: aiCategory || 'Other', date, userId },
    })
    res.status(201).json(expense)
  } catch (error) {
    res.status(500).json({ error: 'Failed to create expense' })
  }
})

// PATCH /expenses/:id — update fields of an existing expense
app.patch('/expenses/:id', async (req, res) => {
  const userId = getAuth(req).userId
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const allowed = ['description', 'amount', 'category', 'date']
  const data = {}
  allowed.forEach(field => {
    if (req.body[field] !== undefined) data[field] = req.body[field]
  })

  try {
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId },
      data,
    })
    res.json(expense)
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to update expense' })
  }
})

// DELETE /expenses/:id — remove an expense from the database
app.delete('/expenses/:id', async (req, res) => {
  const userId = getAuth(req).userId
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    await prisma.expense.delete({
      where: { id: req.params.id, userId },
    })
    res.status(204).send()
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    res.status(500).json({ error: 'Failed to delete expense' })
  }
})


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
