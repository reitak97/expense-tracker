// The single PrismaClient for the whole project — both the API and (later)
// the worker import this same module.
//
// Why this lives in /lib rather than in app.js: the worker is a separate
// process with no HTTP server, but it still needs database access. If the
// client stayed inside app.js, the worker would have to either require app.js
// (pulling in Express, CORS, and Clerk for a process that never serves a
// request) or create a second PrismaClient of its own. A second client means
// a second connection pool against the same Postgres, which is exactly the
// kind of thing that bites under concurrency.
//
// Node caches modules after the first require, so every file that requires
// this gets the identical instance — that's what makes "one client" true.
const { PrismaClient } = require('@prisma/client')

// Note: this only constructs the client, it does NOT connect. Prisma opens a
// connection lazily, on the first actual query. That laziness is load-bearing
// for the test suite: CI runs without a DATABASE_URL, and the auth tests never
// reach a query, so nothing ever tries to dial the database. Calling
// $connect() here would break that.
const prisma = new PrismaClient()

module.exports = { prisma }
