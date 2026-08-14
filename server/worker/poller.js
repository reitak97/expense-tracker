// The SQS poll loop. Owns message lifecycle only — what to do with a batch is
// passed in, so redelivery semantics and categorization stay testable apart.
//
// The rule the whole file exists to enforce: a message is deleted only once its
// work has committed. Anything else leaves it on the queue, where the
// visibility timeout lapses and SQS redelivers it. Duplicate work is safe here
// because writes are keyed by (importId, rowIndex); lost work is not.

const { receiveMessages, deleteMessage } = require('../lib/sqs')

// The SQS per-call maximum. Messages are still processed one at a time —
// running a window in parallel would multiply database load and make the
// visibility timeout much harder to size.
const MAX_MESSAGES_PER_POLL = 10

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs one message through the handler and decides its fate.
 *
 * Never throws: a failed message must not take the rest of the window with it.
 */
async function handleMessage(message, handleBatch) {
  let payload
  try {
    payload = JSON.parse(message.Body)
  } catch (error) {
    // This will never parse, so redelivery cannot help — but deleting it would
    // destroy the evidence. Leaving it lets the redelivery count carry it to
    // the DLQ, which is inspectable.
    console.error('Worker: message body is not valid JSON, leaving for the DLQ:', error)
    return
  }

  // At-least-once delivery makes a second attempt normal. Passing the count on
  // lets a handler tell a retry from a first try without keeping its own state.
  const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1)

  try {
    await handleBatch(payload, { receiveCount })
  } catch (error) {
    // Deliberately not deleted. The visibility timeout expiring is what
    // schedules the retry, and after maxReceiveCount the queue moves it to the
    // DLQ rather than looping forever.
    // Optional chaining because a body of literal `null` parses fine and gets
    // this far. Throwing out of this function would abort the rest of the
    // window, which is the one thing it promises not to do.
    console.error(
      `Worker: batch ${payload?.batchId ?? '<unidentified>'} failed on delivery ${receiveCount}, leaving for redelivery:`,
      error.message
    )
    return
  }

  try {
    await deleteMessage(message.ReceiptHandle)
  } catch (error) {
    // The batch itself committed, so this is not a failure of the work. The
    // redelivery it causes is a no-op against the row-level key.
    console.error('Worker: batch committed but the message could not be deleted:', error.message)
  }
}

/**
 * Receives one window of messages and processes them in order.
 *
 * @param {(payload: object, meta: {receiveCount: number}) => Promise<void>} handleBatch
 * @returns {Promise<number>} how many messages were received
 */
async function pollOnce(handleBatch) {
  const messages = await receiveMessages(MAX_MESSAGES_PER_POLL)

  for (const message of messages) {
    await handleMessage(message, handleBatch)
  }

  return messages.length
}

/**
 * Polls until told to stop.
 *
 * @param {Function} handleBatch - as above
 * @param {object} options
 * @param {() => boolean} options.shouldContinue - checked before each poll; the
 *   shutdown hook, so a SIGTERM stops the loop after the message in flight
 *   rather than abandoning it mid-write
 * @param {number} [options.errorDelayMs] - pause after a failed receive
 * @param {Function} [options.sleep] - injectable for tests
 */
async function runPoller(handleBatch, { shouldContinue, errorDelayMs = 5000, sleep: wait = sleep }) {
  while (shouldContinue()) {
    try {
      await pollOnce(handleBatch)
    } catch (error) {
      // An unreachable queue is transient — exiting would just restart the
      // container into the same condition. Pausing keeps a persistent outage
      // from becoming a hot loop against the API.
      console.error('Worker: poll failed, backing off:', error.message)
      await wait(errorDelayMs)
    }
  }
}

module.exports = { pollOnce, runPoller, MAX_MESSAGES_PER_POLL }
