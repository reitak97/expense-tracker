// Loads .env into process.env at require time.
require('dotenv').config()

/**
 * Throws if any of the named variables is missing or empty.
 *
 * @param {string[]} required - env vars this process cannot run without
 */
function validateEnv(required) {
  // Collect all missing names so one run reports every problem.
  const missing = required.filter((name) => !process.env[name])

  if (missing.length === 0) return

  // Throwing at startup exits non-zero, so a bad deploy fails instead of serving.
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Add them to server/.env (see .env.example), or to the service's ` +
      `environment settings when deploying.`
  )
}

module.exports = { validateEnv }
