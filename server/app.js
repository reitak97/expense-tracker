// Builds the Express app. Does not listen and does not load config — that's
// index.js's job, which is what keeps this file importable by the tests.

const express = require('express')
const cors = require('cors')
const { clerkMiddleware } = require('@clerk/express')
const { ALLOWED_ORIGINS } = require('./lib/allowedOrigins')
const { expensesRouter } = require('./api/routes/expenses')
const { importsRouter } = require('./api/routes/imports')

const app = express()

// Allowlist the two frontends permitted to call this API cross-origin. The
// WebSocket upgrade checks the same list separately — CORS doesn't cover it.
app.use(cors({ origin: ALLOWED_ORIGINS }))

// Without this, req.body is undefined on POST/PATCH.
app.use(express.json())

// What Render polls to decide the service is alive. Deliberately touches
// nothing — a health check that queried Postgres would turn a database blip
// into a restart loop, taking the API down for the one reason it was still
// able to serve traffic through. Above clerkMiddleware so it needs no session.
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Parses auth off the request; rejecting is requireAuth's job, per router.
app.use(clerkMiddleware())

// Must come after clerkMiddleware — requireAuth calls getAuth().
app.use(expensesRouter)

// Multipart, so it parses its own body — express.json() above ignores it.
app.use(importsRouter)

module.exports = app
