// Queue access for both processes: batching rules and polling defaults in one place.

const {
  SQSClient,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} = require('@aws-sdk/client-sqs')

// SQS API limit, not a tuning knob.
const MAX_SEND_BATCH = 10

// Mirrors maxReceiveCount in the queue's redrive policy — SQS is what enforces
// it. Kept here so the worker can recognize its last attempt and record why the
// batch failed before the message moves to the DLQ. Change both together, with
// scripts/configure-dlq.js.
const MAX_RECEIVE_COUNT = 5

// Built on first use, so this module imports fine without AWS config (e.g. in tests).
let client = null

function getClient() {
  if (!client) {
    // Credentials come from the environment via the SDK's own resolver.
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

  // Chunked because of the 10-entry API limit above.
  for (let offset = 0; offset < payloads.length; offset += MAX_SEND_BATCH) {
    const chunk = payloads.slice(offset, offset + MAX_SEND_BATCH)

    // AWS SDK v3 shape: build a Command describing the call, hand it to send().
    const result = await getClient().send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl(),
        // Entries = the messages in this one call, max 10.
        Entries: chunk.map((payload, i) => ({
          // A label AWS echoes back so we can tell which entry failed.
          // Unique within the request only; position in the whole list.
          Id: String(offset + i),
          // SQS only carries strings, so the object is JSON-encoded here and
          // JSON.parse'd by the worker on the other side.
          MessageBody: JSON.stringify(payload),
        })),
      })
    )

    sent += (result.Successful || []).length

    // SendMessageBatch resolves even when entries fail — they arrive here, not as a throw.
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

      // Parks up to 20s instead of returning empty immediately.
      WaitTimeSeconds: 20,

      // Lets the worker tell a redelivery from a first attempt.
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
  )

  return result.Messages || []
}

/**
 * Removes a message from the queue. Call only after the batch's writes commit —
 * deleting first would trade duplicate work for lost work.
 */
async function deleteMessage(receiptHandle) {
  await getClient().send(
    new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle })
  )
}

/**
 * Extends the lease on an in-flight message, for batches running past the
 * visibility timeout.
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
  MAX_RECEIVE_COUNT,
}
