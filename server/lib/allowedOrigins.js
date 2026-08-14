// The frontends allowed to talk to this API, in one place.
//
// Both entry points need the same list and enforce it separately: CORS covers
// XHR and fetch, but it does not apply to WebSocket handshakes, so lib/ws.js
// has to check Origin itself.

const ALLOWED_ORIGINS = ['http://localhost:5173', 'https://expense-tracker-two-pi-27.vercel.app']

module.exports = { ALLOWED_ORIGINS }
