
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
