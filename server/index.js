// Entrypoint for the API process. `npm run dev` and `npm start` both run this.
//
// An entrypoint's job is to load configuration, check it, and start something.
// The app itself is built in app.js — see the note there about why the two
// are separate.

// Requiring lib/env runs dotenv.config(), which populates process.env from the
// .env file. This MUST come before require('./app') on the line below:
// app.js loads api/routes/expenses.js, which constructs the Anthropic client
// at module load, and that constructor reads ANTHROPIC_API_KEY immediately.
// Require it after, and it reads an env that hasn't been populated yet.
const { validateEnv } = require('./lib/env')

// Fail fast. Every variable the API cannot function without is listed here, so
// a misconfigured deploy dies at boot with a message naming exactly what's
// missing — rather than starting fine and 500ing on the first request that
// touches the database.
//
// The worker will call this same function with its own different list
// (DATABASE_URL, the SQS queue URL, AWS region — but no Clerk key, since it
// never handles an HTTP request). That's why the list is an argument.
// DIRECT_URL is not listed: it's read by the Prisma CLI during migrations, not
// by the running server, so a missing one shouldn't stop the API from booting.
validateEnv(['DATABASE_URL', 'CLERK_SECRET_KEY', 'ANTHROPIC_API_KEY'])

// app.js builds the Express app (routes, middleware) but never starts it.
// Splitting "build" from "run" like this means tests can import app.js
// and hit routes directly, without opening a real network port.
const app = require('./app')

// Railway/Render assign a port at runtime via process.env.PORT.
// Locally that variable won't exist, so we fall back to 3001.
const PORT = process.env.PORT || 3001

// Starts the server listening for HTTP requests. The callback just
// confirms it's up — it doesn't run per-request, only once at boot.
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
