// Written before worker/poller.js. The rule under test is message lifecycle:
// a message is deleted only once its work has committed, and anything short of
// that must leave it on the queue so SQS redelivers it.
//
// Nothing here touches categorization or the database — the poller's only job
// is deciding what happens to a message, and it takes the work to do as a
// callback so those two concerns can be tested apart.

jest.mock('../lib/sqs', () => ({
  receiveMessages: jest.fn(),
  deleteMessage: jest.fn(),
}))

const { receiveMessages, deleteMessage } = require('../lib/sqs')
const { pollOnce, runPoller, MAX_MESSAGES_PER_POLL } = require('../worker/poller')

// The shape SQS actually returns: the payload is a JSON string, and the
// receive count arrives as a string too.
function sqsMessage(payload, { receiptHandle = 'rh_1', receiveCount = 1 } = {}) {
  return {
    MessageId: 'msg_1',
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify(payload),
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
  }
}

const BATCH = { importId: 'imp_1', batchId: 'batch_0', userId: 'user_alice', batchIndex: 0, rows: [] }

beforeEach(() => {
  jest.clearAllMocks()
  receiveMessages.mockResolvedValue([])
  deleteMessage.mockResolvedValue(undefined)
  // The poller logs failures rather than throwing, so silence the noise and
  // let the tests assert on behavior instead.
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  console.error.mockRestore()
})

describe('pollOnce', () => {
  test('asks for a full window of messages', async () => {
    await pollOnce(jest.fn())

    expect(receiveMessages).toHaveBeenCalledWith(MAX_MESSAGES_PER_POLL)
  })

  test('hands the parsed payload to the handler', async () => {
    const handler = jest.fn().mockResolvedValue(undefined)
    receiveMessages.mockResolvedValue([sqsMessage(BATCH)])

    await pollOnce(handler)

    expect(handler).toHaveBeenCalledWith(BATCH, expect.anything())
  })

  // The whole point of the ordering. Deleting first would trade duplicate work
  // — which the row-level key makes harmless — for lost work, which nothing
  // recovers from.
  test('deletes the message only after the handler resolves', async () => {
    const order = []
    const handler = jest.fn().mockImplementation(async () => {
      order.push('handled')
    })
    deleteMessage.mockImplementation(async () => {
      order.push('deleted')
    })
    receiveMessages.mockResolvedValue([sqsMessage(BATCH)])

    await pollOnce(handler)

    expect(order).toEqual(['handled', 'deleted'])
    expect(deleteMessage).toHaveBeenCalledWith('rh_1')
  })

  // Leaving the message alone is what triggers redelivery: the visibility
  // timeout lapses and SQS hands it to a worker again.
  test('leaves the message on the queue when the handler throws', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('categorization failed'))
    receiveMessages.mockResolvedValue([sqsMessage(BATCH)])

    await pollOnce(handler)

    expect(deleteMessage).not.toHaveBeenCalled()
  })

  // A poison batch must not take the other nine down with it.
  test('keeps processing the rest of the window after one message fails', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('bad batch'))
      .mockResolvedValue(undefined)
    receiveMessages.mockResolvedValue([
      sqsMessage(BATCH, { receiptHandle: 'rh_bad' }),
      sqsMessage(BATCH, { receiptHandle: 'rh_good' }),
    ])

    await pollOnce(handler)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage).toHaveBeenCalledWith('rh_good')
  })

  // At-least-once delivery means a second attempt is normal, not exceptional.
  // The handler needs the count to tell them apart — it is how a retry can act
  // differently from a first try without keeping state of its own.
  test('tells the handler how many times the message has been delivered', async () => {
    const handler = jest.fn().mockResolvedValue(undefined)
    receiveMessages.mockResolvedValue([sqsMessage(BATCH, { receiveCount: 3 })])

    await pollOnce(handler)

    expect(handler).toHaveBeenCalledWith(BATCH, { receiveCount: 3 })
  })

  test('treats a missing receive count as a first delivery', async () => {
    const handler = jest.fn().mockResolvedValue(undefined)
    const message = sqsMessage(BATCH)
    delete message.Attributes
    receiveMessages.mockResolvedValue([message])

    await pollOnce(handler)

    expect(handler).toHaveBeenCalledWith(BATCH, { receiveCount: 1 })
  })

  // An unparseable body will never parse, so retrying is pointless — but
  // deleting it destroys the evidence. Leaving it lets redelivery carry it to
  // the DLQ, where it can be inspected.
  test('does not delete or hand on a message whose body is not JSON', async () => {
    const handler = jest.fn()
    receiveMessages.mockResolvedValue([{ ReceiptHandle: 'rh_1', Body: '{not json' }])

    await pollOnce(handler)

    expect(handler).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  // A delete that fails is not a failed batch: the work committed, and the
  // redelivery it causes is a no-op thanks to the row-level key.
  test('does not treat a failed delete as a failed batch', async () => {
    const handler = jest.fn().mockResolvedValue(undefined)
    deleteMessage.mockRejectedValue(new Error('receipt handle expired'))
    receiveMessages.mockResolvedValue([sqsMessage(BATCH)])

    await expect(pollOnce(handler)).resolves.toBe(1)
  })

  test('returns the number of messages it received', async () => {
    receiveMessages.mockResolvedValue([sqsMessage(BATCH), sqsMessage(BATCH)])

    await expect(pollOnce(jest.fn().mockResolvedValue(undefined))).resolves.toBe(2)
  })

  test('does nothing on an empty queue', async () => {
    const handler = jest.fn()

    await expect(pollOnce(handler)).resolves.toBe(0)
    expect(handler).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })
})

describe('runPoller', () => {
  // shouldContinue is the shutdown hook: SIGTERM flips it, and the loop stops
  // after the message in flight rather than abandoning it mid-write.
  test('polls until shouldContinue goes false', async () => {
    let remaining = 3
    const shouldContinue = () => remaining-- > 0

    await runPoller(jest.fn(), { shouldContinue, errorDelayMs: 0 })

    expect(receiveMessages).toHaveBeenCalledTimes(3)
  })

  test('checks for shutdown before the first poll', async () => {
    await runPoller(jest.fn(), { shouldContinue: () => false, errorDelayMs: 0 })

    expect(receiveMessages).not.toHaveBeenCalled()
  })

  // The queue being briefly unreachable is a transient condition, not a reason
  // to exit — the container would just be restarted into the same situation.
  test('survives a failed receive and keeps polling', async () => {
    let remaining = 3
    receiveMessages
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValue([])

    await runPoller(jest.fn(), {
      shouldContinue: () => remaining-- > 0,
      errorDelayMs: 0,
    })

    expect(receiveMessages).toHaveBeenCalledTimes(3)
  })

  // Without a pause, an unreachable queue becomes a hot loop that burns CPU
  // and API calls until someone notices.
  test('backs off after a failed receive', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined)
    let remaining = 2
    receiveMessages.mockRejectedValueOnce(new Error('throttled')).mockResolvedValue([])

    await runPoller(jest.fn(), {
      shouldContinue: () => remaining-- > 0,
      errorDelayMs: 5000,
      sleep,
    })

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(5000)
  })

  test('does not back off when a poll succeeds', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined)
    let remaining = 2

    await runPoller(jest.fn(), {
      shouldContinue: () => remaining-- > 0,
      errorDelayMs: 5000,
      sleep,
    })

    expect(sleep).not.toHaveBeenCalled()
  })
})
