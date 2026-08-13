// Entrypoint for the API process: load config, check it, start the server.

// Must precede require('./app') — requiring this runs dotenv.config(), and
// app.js constructs the Anthropic client at module load.
const { validateEnv } = require('./lib/env')

// The API's own required vars; the worker will pass a different list.
// DIRECT_URL is absent because only the Prisma CLI reads it, during migrations.
validateEnv(['DATABASE_URL', 'CLERK_SECRET_KEY', 'ANTHROPIC_API_KEY'])

const http = require('http')

const app = require('./app')
const { attachWebSocketServer } = require('./lib/ws')

// Render/Railway assign PORT at runtime.
const PORT = process.env.PORT || 3001

// Explicit server rather than app.listen(), so the progress socket can share
// the port — Render web services only expose one.
const server = http.createServer(app)

attachWebSocketServer(server)

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Import progress socket on ws://localhost:${PORT}/ws`)
})
