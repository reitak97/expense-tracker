// Builds the Express application: middleware, then routes. It does NOT start
// the server — index.js calls app.listen() on what this exports.
//
// That build/run split is what lets __tests__/expenses.test.js require this
// file and fire requests at it through supertest without opening a real port.
//
// Note what's deliberately absent: no dotenv, no validateEnv. Loading and
// checking configuration is the entrypoint's job (index.js, worker.js), not
// this module's. If validation lived here, `npm test` would demand a real
// DATABASE_URL just to import the app — and CI runs the suite without one.

const express = require('express')
const cors = require('cors')

// clerkMiddleware reads the auth token off incoming requests. Clerk = auth
// provider, so this app never has to handle passwords/sessions itself.
const { clerkMiddleware } = require('@clerk/express')

// The expense endpoints, grouped into a Router in their own file.
const { expensesRouter } = require('./api/routes/expenses')

// The Express application instance. Middleware and routes get attached below.
const app = express()

// CORS: by default, browsers block a page on one origin (your Vite dev
// server / deployed frontend) from calling an API on another origin (this
// server). This explicitly allowlists the two frontends that are allowed to.
app.use(cors({ origin: ['http://localhost:5173', 'https://expense-tracker-two-pi-27.vercel.app'] }))

// Without this, req.body would be undefined on POST/PATCH — this middleware
// parses incoming JSON request bodies and attaches the result to req.body.
app.use(express.json())

// Runs before every route. It doesn't block unauthenticated requests itself —
// it just inspects the request and makes getAuth(req) available downstream.
// Rejecting unauthenticated requests is requireAuth's job, applied per-router,
// so a future public route (a health check, say) can opt out of it.
app.use(clerkMiddleware())

// Mount the expense routes. Order matters in Express: this must come after
// clerkMiddleware(), because requireAuth inside the router calls getAuth(),
// which only works once clerkMiddleware has parsed the request.
app.use(expensesRouter)

// Exported without listening, so index.js can call .listen() on it and the
// tests can import it directly. Left as a bare export (not { app }) because
// it's this module's single reason to exist.
module.exports = app
