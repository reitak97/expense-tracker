// Environment configuration: loading it, and checking it's complete.
//
// Two separate jobs, deliberately split:
//   1. Requiring this module LOADS .env into process.env (a side effect).
//   2. Calling validateEnv() CHECKS that specific vars are present.
//
// The split matters because the API and the worker are different processes
// that need different variables. The worker never sees an HTTP request, so it
// has no use for CLERK_SECRET_KEY; the API never talks to SQS, so it has no
// use for a queue URL. Each entrypoint declares its own list rather than
// sharing one hardcoded set that would be wrong for both.

// dotenv reads the .env file sitting next to package.json and copies each
// KEY=value line into process.env. This runs at require-time, before any
// exported function below can be called, which guarantees process.env is
// populated by the time anyone validates or reads it.
//
// Note: .env is gitignored and only exists on your machine. In production
// (Render) and in CI (GitHub Actions) there is no .env file — the platform
// injects real environment variables directly, so this call finds nothing to
// read and quietly does nothing. That's intended, not a failure.
require('dotenv').config()

/**
 * Throws if any of the named variables is missing or empty.
 *
 * @param {string[]} required - names of env vars this process cannot run without
 */
function validateEnv(required) {
  // Collect every missing name instead of throwing on the first one. If three
  // variables are unset you want to learn all three in a single run, rather
  // than fix-rerun-fix-rerun three times.
  //
  // .filter() walks the array and keeps only the entries where the callback
  // returns true — here, the names whose value in process.env is falsy.
  // Falsy covers both "never set" (undefined) and "set but empty", and an
  // empty DATABASE_URL is just as broken as a missing one.
  //
  // process.env[name] is bracket notation: the key is a variable, not a
  // literal, so it can't be written as process.env.name.
  const missing = required.filter((name) => !process.env[name])

  // Empty array = nothing missing = valid. Return quietly, startup continues.
  if (missing.length === 0) return

  // .join(', ') turns ['DATABASE_URL', 'AWS_REGION'] into
  // "DATABASE_URL, AWS_REGION" so the message reads as a sentence.
  //
  // Throwing — rather than console.error and carrying on — is the "fail fast,
  // fail loud" rule from CLAUDE.md. An uncaught throw during startup exits the
  // process with a non-zero code, so Render marks the deploy failed instead of
  // running a server that 500s on every request that touches the database.
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Add them to server/.env (see .env.example), or to the service's ` +
      `environment settings when deploying.`
  )
}

// Named export per the code style in CLAUDE.md — `{ validateEnv }` rather than
// the bare function. Callers write `const { validateEnv } = require(...)`,
// which makes the import site self-describing and leaves room to add more
// helpers here later without changing how existing callers import.
module.exports = { validateEnv }
