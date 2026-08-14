import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'

// A 10,000-row import takes minutes, so the page can't just await the upload.
// The server pushes progress over a WebSocket; if that connection can't be made
// or drops, this falls back to polling the same shape from GET /imports/:id.
// Either way the caller gets one `progress` object and doesn't know which.

const API_URL = import.meta.env.VITE_API_URL

// Only used after the socket fails, so it can be slower than the server's own
// 1.5s push interval without the user noticing on the happy path.
const POLL_INTERVAL_MS = 2500

// http://host -> ws://host, https -> wss.
function socketUrl(token) {
  const base = API_URL.replace(/^http/, 'ws')
  // The browser can't set headers on a WebSocket handshake, so the session
  // token rides in the query string instead of an Authorization header.
  return `${base}/ws?token=${encodeURIComponent(token)}`
}

function isSettled(progress) {
  return progress?.status === 'COMPLETED' || progress?.status === 'FAILED'
}

/**
 * Tracks one import until it settles.
 *
 * @param {string|null} importId - null when nothing is importing
 * @returns {{progress: object|null, transport: 'idle'|'connecting'|'socket'|'polling', error: string|null}}
 */
export function useImportProgress(importId) {
  const { getToken } = useAuth()

  // Tagged with the import it describes, so a frame left over from the previous
  // import is never rendered against the new one. That tag is also what lets
  // this hook reset without writing state from the effect body.
  const [state, setState] = useState({ importId: null, progress: null, transport: 'idle', error: null })

  // The effect deliberately doesn't depend on `state`, so what it closes over is
  // frozen. Callbacks that need to know whether the import settled read this.
  const latest = useRef(null)

  useEffect(() => {
    if (!importId) return undefined

    // Local to this run, not a ref. A ref is shared across runs, so the next
    // run resetting it to false would un-cancel the previous run's pending
    // awaits — which then build a socket and an interval that the cleanup for
    // that run has already finished and can no longer reach.
    let cancelled = false

    latest.current = null

    let socket = null
    let pollTimer = null

    function record(progress, transport) {
      latest.current = progress
      setState({ importId, progress, transport, error: null })
    }

    function fail(message, transport) {
      setState((previous) => ({ ...previous, importId, transport, error: message }))
    }

    // The fallback path. Runs on any socket failure, and also covers a proxy
    // that silently refuses to upgrade.
    async function startPolling() {
      if (cancelled || pollTimer) return

      async function poll() {
        try {
          const token = await getToken()
          const response = await fetch(`${API_URL}/imports/${importId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!response.ok) throw new Error(`Import status returned ${response.status}`)

          const next = await response.json()
          if (cancelled) return

          record(next, 'polling')
          if (isSettled(next)) {
            clearInterval(pollTimer)
            pollTimer = null
          }
        } catch (pollError) {
          if (!cancelled) fail(pollError.message, 'polling')
        }
      }

      // Marked before the first request so the UI stops claiming a live socket.
      pollTimer = setInterval(poll, POLL_INTERVAL_MS)
      await poll()
    }

    async function connect() {
      let token
      try {
        token = await getToken()
      } catch {
        // No token means no socket and no REST call either; surface it rather
        // than spinning on a connection that can never authenticate.
        if (!cancelled) fail('Could not authenticate', 'idle')
        return
      }
      if (cancelled) return

      try {
        socket = new WebSocket(socketUrl(token))
      } catch {
        startPolling()
        return
      }

      socket.onopen = () => {
        if (cancelled) return
        setState((previous) => ({ ...previous, importId, transport: 'socket' }))
        socket.send(JSON.stringify({ type: 'subscribe', importId }))
      }

      socket.onmessage = (event) => {
        if (cancelled) return
        const message = JSON.parse(event.data)

        if (message.type === 'progress' || message.type === 'done') {
          record(message.progress, 'socket')
        } else if (message.type === 'error') {
          fail(message.error, 'socket')
        }
      }

      // Either handler can fire; startPolling is idempotent, so both is fine.
      socket.onerror = () => startPolling()
      socket.onclose = () => {
        // A close after the import settled is the normal end, not a failure.
        if (!cancelled && !isSettled(latest.current)) startPolling()
      }
    }

    connect()

    return () => {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      // Detached before closing, so onclose doesn't start polling an import
      // nobody is watching any more.
      if (socket) {
        socket.onclose = null
        socket.onerror = null
        socket.close()
      }
    }
  }, [importId, getToken])

  // Derived rather than stored: state left over from a previous import reads as
  // "nothing yet" instead of briefly rendering the wrong file's progress.
  const current = state.importId === importId

  return {
    progress: current ? state.progress : null,
    transport: importId ? (current ? state.transport : 'connecting') : 'idle',
    error: current ? state.error : null,
  }
}
