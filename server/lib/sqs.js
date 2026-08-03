// Thin wrapper over the SQS SDK. Both processes talk to the queue through
// here rather than constructing their own clients, so the batching rules and
// long-polling defaults live in exactly one place.

const {
  SQSClient,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} = require('@aws-sdk/client-sqs')

// SQS caps a SendMessageBatch at 10 entries. Not a tuning knob — an API limit.
const MAX_SEND_BATCH = 10

// The client is built on first use, not at require time.
//
// This matters for the same reason validateEnv() isn't called in app.js: the
// test suite imports the route modules, which import this file, and CI has no
// AWS credentials. Constructing the client at module load would read AWS_REGION
// during an ordinary `npm test` and couple the suite to config it shouldn't
// need. Lazy construction keeps this module importable everywhere and only
// demanding of config at the moment someone actually sends a message.
let client = null

function getClient() {
  if (!client) {
    // Credentials are deliberately absent here. The SDK resolves them from
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment on its own,
    // and on a real deploy it would use the instance role instead. Passing them
    // explicitly would break that fallback chain for no benefit.
    client = new SQSClient({ region: process.env.AWS_REGION })
  }
  return client
}

function queueUrl() {
  return process.env.SQS_QUEUE_URL
}

/**
 * Enqueues one message per batch of CSV rows.
 *
 * @param {Array<object>} payloads - one object per batch, JSON-serializable
 * @returns {Promise<{sent: number, failed: Array<{index: number, reason: string}>}>}
 */
async function sendBatchMessages(payloads) {
  const failed = []
  let sent = 0

  // Walk the payloads in chunks of 10 because of the API limit above. A
  // 10,000-row file at 100 rows per batch is 100 messages, so 10 API calls
  // instead of 100 — the same "batch the round trips" idea the row batching
  // itself is based on, one layer up.
  for (let offset = 0; offset < payloads.length; offset += MAX_SEND_BATCH) {
    const chunk = payloads.slice(offset, offset + MAX_SEND_BATCH)

    const result = await getClient().send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl(),
        Entries: chunk.map((payload, i) => ({
          // Id only has to be unique within this request, not globally. Using
          // the absolute batch position keeps the mapping back to the original
          // payload obvious when reading a Failed entry below.
          Id: String(offset + i),
          MessageBody: JSON.stringify(payload),
        })),
      })
    )

    sent += (result.Successful || []).length

    // SendMessageBatch is partially successful by design: the call resolves
    // even when some entries fail, and the failures are in the response rather
    // than thrown. Ignoring result.Failed is the classic bug here — it silently
    // drops batches, and the import then hangs forever at 90% because the
    // messages for those rows were never actually enqueued.
    for (const f of result.Failed || []) {
      failed.push({ index: Number(f.Id), reason: `${f.Code}: ${f.Message}` })
    }
  }

  return { sent, failed }
}

/**
 * Long-polls for messages. Returns [] when the queue is empty.
 *
 * @param {number} max - up to 10 messages per call
 */
async function receiveMessages(max = 1) {
  const result = await getClient().send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(),
      MaxNumberOfMessages: max,

      // Long polling: the call parks for up to 20s waiting for a message
      // instead of returning empty immediately. With short polling a worker
      // loop spins as fast as the network allows, burning requests against the
      // free tier and CPU for nothing. The queue itself is also configured with
      // a 20s default; passing it explicitly means the worker behaves the same
      // way even if someone edits the queue later.
      WaitTimeSeconds: 20,

      // ApproximateReceiveCount tells us how many times this message has been
      // delivered. That is how the worker knows it's looking at a redelivery
      // rather than a first attempt — worth recording, since a batch on its
      // third try is about to hit the DLQ.
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
  )

  return result.Messages || []
}

/**
 * Removes a message from the queue. Call this only after the batch's writes
 * have committed.
 *
 * The ordering is the entire redelivery mechanism: if the worker crashes
 * between committing and deleting, the visibility timeout lapses and SQS hands
 * the message to another worker. That replay is safe because the writes are
 * idempotent. Deleting first would trade duplicate work for lost work, which
 * is the worse failure.
 */
async function deleteMessage(receiptHandle) {
  await getClient().send(
    new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle })
  )
}

/**
 * Extends the lease on an in-flight message.
 *
 * The escape hatch for a batch running longer than the 60s visibility timeout —
 * a cold merchant cache means real LLM calls for every row. Without this, SQS
 * would decide the worker died and hand the batch to a second worker while the
 * first is still working on it.
 */
async function extendVisibility(receiptHandle, seconds) {
  await getClient().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    })
  )
}

module.exports = {
  sendBatchMessages,
  receiveMessages,
  deleteMessage,
  extendVisibility,
  MAX_SEND_BATCH,
}
