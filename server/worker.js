// Entrypoint for the worker process: load config, check it, poll until stopped.
// Mirrors index.js — the API's counterpart — and holds no logic of its own so
// worker/ stays importable by the tests.

const { validateEnv } = require('./lib/env')

// The worker's own list. No CLERK_SECRET_KEY: it never serves a request and has
// no session to verify, taking the user id from the queue message instead.
validateEnv(['DATABASE_URL', 'ANTHROPIC_API_KEY', 'SQS_QUEUE_URL', 'AWS_REGION'])

const { runPoller } = require('./worker/poller')
const { processBatch } = require('./worker/processBatch')

// Flipped by the signal handlers below. Checked before each poll, so shutdown
// waits for the message in flight instead of abandoning it mid-write.
let running = true

// Render sends SIGTERM on every deploy and restart. Draining rather than dying
// means the batch in progress finishes; anything still queued is simply
// redelivered to the next container. 
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!running) {
      // A second signal means someone wants it gone now.
      console.log(`Worker: ${signal} again, exiting immediately`)
      process.exit(1)
    }
    console.log(`Worker: ${signal} received, finishing the current batch`)
    running = false
  })
}

runPoller(processBatch, { shouldContinue: () => running })
  .then(() => {
    console.log('Worker: stopped')
    process.exit(0)
  })
  .catch((error) => {
    // runPoller swallows per-poll failures, so reaching here means something
    // structural. Exiting non-zero lets the platform restart it.
    console.error('Worker: exiting on an unrecoverable error:', error)
    process.exit(1)
  })
