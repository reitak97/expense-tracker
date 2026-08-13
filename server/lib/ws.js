// Push progress to the client while an import runs.
//
// The worker and the API are separate processes, so the worker cannot reach
// these sockets. It writes progress to Postgres and this server reads it back:
// one query per import that somebody is actually watching, on an interval, and
// a frame only when something changed. See DESIGN.md — "Progress over
// WebSockets" for why this beats a queue or a second channel here.

const { WebSocketServer } = require('ws')
const { verifyToken } = require('@clerk/backend')

const { ALLOWED_ORIGINS } = require('./allowedOrigins')
const { getImportProgress, isSettled } = require('./importProgress')

// The one path that upgrades. Shared with the client's socket URL.
const WS_PATH = '/ws'

// Fast enough to feel live, slow enough that ten watchers cost ten queries
// every second and a half rather than a sustained read load.
const POLL_INTERVAL_MS = 1500

// Two missed heartbeats and the socket is presumed gone. Without this, a client
// that vanishes without closing keeps its subscription polling forever.
const HEARTBEAT_INTERVAL_MS = 30000

// ws -> { userId, importId, lastFrame, alive }
const subscribers = new Map()

/**
 * Rejects the upgrade before a socket exists, so an unauthenticated client
 * never gets a connection to hold open.
 */
async function authenticate(request) {
  const url = new URL(request.url, 'http://localhost')
  const token = url.searchParams.get('token')
  if (!token) return null

  try {
    // The browser cannot set headers on a WebSocket handshake, so the session
    // token arrives in the query string rather than an Authorization header.
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY })
    return payload.sub || null
  } catch (error) {
    console.error('WS: token verification failed:', error.message)
    return null
  }
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

/**
 * Subscribes a socket to one import, after confirming it belongs to the user.
 */
async function subscribe(ws, userId, importId) {
  if (typeof importId !== 'string' || !importId) {
    return send(ws, { type: 'error', error: 'subscribe requires an importId' })
  }

  const progress = await getImportProgress(userId, importId)
  if (!progress) {
    // Same answer for someone else's import as for one that doesn't exist.
    return send(ws, { type: 'error', error: 'Import not found' })
  }

  const state = subscribers.get(ws)
  state.importId = importId
  state.lastFrame = JSON.stringify(progress)

  // Sent immediately so the client renders current state rather than waiting
  // out a poll interval for its first frame.
  send(ws, { type: 'progress', progress })
  if (isSettled(progress)) send(ws, { type: 'done', progress })
}

/**
 * One poll pass: read every watched import once, push what changed.
 */
async function pollSubscribers() {
  // Grouped so ten people watching one import cost one query, not ten.
  const watched = new Map()
  for (const [ws, state] of subscribers) {
    if (!state.importId) continue
    const key = `${state.userId}:${state.importId}`
    if (!watched.has(key)) watched.set(key, { userId: state.userId, importId: state.importId, sockets: [] })
    watched.get(key).sockets.push(ws)
  }

  for (const { userId, importId, sockets } of watched.values()) {
    let progress
    try {
      progress = await getImportProgress(userId, importId)
    } catch (error) {
      // A transient database error should not tear down the socket; the next
      // pass tries again, and the REST fallback still works meanwhile.
      console.error(`WS: progress query failed for ${importId}:`, error.message)
      continue
    }

    if (!progress) continue
    const frame = JSON.stringify(progress)

    for (const ws of sockets) {
      const state = subscribers.get(ws)
      if (!state || state.lastFrame === frame) continue

      state.lastFrame = frame
      send(ws, { type: 'progress', progress })

      // Terminal: stop polling for this socket but leave it open, so the client
      // can subscribe to another import without reconnecting.
      if (isSettled(progress)) {
        send(ws, { type: 'done', progress })
        state.importId = null
      }
    }
  }
}

/**
 * Attaches the progress socket to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @returns {{ close: () => void }} for tests and graceful shutdown
 */
function attachWebSocketServer(httpServer) {
  // noServer, so the upgrade can be rejected on auth before a socket exists.
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (request, socket, head) => {
    // Only /ws is a progress socket. Anything else is left alone so a future
    // upgrade handler on this server still gets its own paths.
    if (new URL(request.url, 'http://localhost').pathname !== WS_PATH) return

    const origin = request.headers.origin
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      // CORS does not cover WebSocket handshakes, so this check is the only
      // thing standing between another site and a user's progress stream.
      socket.destroy()
      return
    }

    const userId = await authenticate(request)
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, userId)
    })
  })

  wss.on('connection', (ws, request, userId) => {
    subscribers.set(ws, { userId, importId: null, lastFrame: null, alive: true })

    ws.on('pong', () => {
      const state = subscribers.get(ws)
      if (state) state.alive = true
    })

    ws.on('message', async (raw) => {
      let message
      try {
        message = JSON.parse(raw)
      } catch (error) {
        return send(ws, { type: 'error', error: 'Message must be JSON' })
      }

      if (message.type === 'subscribe') {
        await subscribe(ws, userId, message.importId).catch((error) => {
          console.error('WS: subscribe failed:', error.message)
          send(ws, { type: 'error', error: 'Could not subscribe' })
        })
      } else if (message.type === 'unsubscribe') {
        const state = subscribers.get(ws)
        if (state) state.importId = null
      }
    })

    ws.on('close', () => subscribers.delete(ws))
    ws.on('error', () => subscribers.delete(ws))
  })

  const pollTimer = setInterval(() => {
    pollSubscribers().catch((error) => console.error('WS: poll pass failed:', error.message))
  }, POLL_INTERVAL_MS)

  const heartbeatTimer = setInterval(() => {
    for (const [ws, state] of subscribers) {
      if (!state.alive) {
        ws.terminate()
        subscribers.delete(ws)
        continue
      }
      state.alive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  // Timers would otherwise keep the process alive after the server closes.
  pollTimer.unref?.()
  heartbeatTimer.unref?.()

  return {
    close() {
      clearInterval(pollTimer)
      clearInterval(heartbeatTimer)
      for (const ws of subscribers.keys()) ws.terminate()
      subscribers.clear()
      wss.close()
    },
  }
}

module.exports = { attachWebSocketServer, POLL_INTERVAL_MS, WS_PATH }
