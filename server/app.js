// Builds the Express app. Does not listen and does not load config — that's
// index.js's job, which is what keeps this file importable by the tests.

const express = require('express')
const cors = require('cors')
const { clerkMiddleware } = require('@clerk/express')
const { expensesRouter } = require('./api/routes/expenses')

const app = express()

// Allowlist the two frontends permitted to call this API cross-origin.
app.use(cors({ origin: ['http://localhost:5173', 'https://expense-tracker-two-pi-27.vercel.app'] }))

// Without this, req.body is undefined on POST/PATCH.
app.use(express.json())

// Parses auth off the request; rejecting is requireAuth's job, per router.
app.use(clerkMiddleware())

// Must come after clerkMiddleware — requireAuth calls getAuth().
app.use(expensesRouter)

module.exports = app
