// Creates the dead-letter queue and attaches it to the main queue.
//
//   node scripts/configure-dlq.js            # show what would change
//   node scripts/configure-dlq.js --apply    # make the changes
//
// The redrive policy is what stops a poison batch retrying forever: after
// maxReceiveCount deliveries SQS moves the message to the DLQ instead of making
// it visible again. Nothing in the worker enforces this — the code only ever
// declines to delete, so without this policy a bad message loops indefinitely.
//
// Idempotent: CreateQueue on an existing name returns the existing queue, and
// re-running only rewrites attributes that already match.

const {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs')

const { validateEnv } = require('../lib/env')
const { MAX_RECEIVE_COUNT } = require('../lib/sqs')

validateEnv(['SQS_QUEUE_URL', 'AWS_REGION'])

const apply = process.argv.includes('--apply')

const client = new SQSClient({ region: process.env.AWS_REGION })

const mainQueueUrl = process.env.SQS_QUEUE_URL
const mainQueueName = mainQueueUrl.split('/').pop()
const dlqName = `${mainQueueName}-dlq`

// The maximum. Retention runs from the message's ORIGINAL enqueue time, not
// from when it reached the DLQ, so a shorter window quietly eats the evidence
// while you are still working out what went wrong.
const DLQ_RETENTION_SECONDS = 14 * 24 * 60 * 60

// Has to exceed the slowest batch, or SQS redelivers work that is still
// running: duplicate LLM calls, and a batch that can exhaust its redeliveries
// while succeeding every time. A batch is bounded by one Anthropic call plus a
// short transaction, so this is roughly 10x headroom.
const VISIBILITY_TIMEOUT_SECONDS = 300

async function main() {
  console.log(`Main queue: ${mainQueueName}`)
  console.log(`DLQ:        ${dlqName}\n`)

  // Read first, so a dry run shows the delta rather than just the intent — and
  // so a drifted maxReceiveCount is visible before it silently truncates the
  // worker's retries.
  const { Attributes: current = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: mainQueueUrl,
      AttributeNames: ['RedrivePolicy', 'VisibilityTimeout'],
    })
  )

  const currentPolicy = current.RedrivePolicy ? JSON.parse(current.RedrivePolicy) : null
  console.log(`  maxReceiveCount   ${currentPolicy?.maxReceiveCount ?? '(no redrive policy)'} -> ${MAX_RECEIVE_COUNT}`)
  console.log(`  visibilityTimeout ${current.VisibilityTimeout ?? '?'}s -> ${VISIBILITY_TIMEOUT_SECONDS}s`)
  console.log(`  dlq retention     -> ${DLQ_RETENTION_SECONDS / 86400} days\n`)

  // The worker reads its own last delivery off MAX_RECEIVE_COUNT to record why
  // a batch failed. If the queue gives up sooner, that never runs and the batch
  // reaches the DLQ with the import stuck and no explanation.
  if (currentPolicy && currentPolicy.maxReceiveCount !== MAX_RECEIVE_COUNT) {
    console.log(
      `  NOTE: the queue and lib/sqs.js disagree on maxReceiveCount. Applying makes\n` +
        `  the queue match the code. To go the other way, edit MAX_RECEIVE_COUNT instead.\n`
    )
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to make these changes.')
    return
  }

  // Looked up before creating: CreateQueue is only idempotent when every
  // attribute matches, so calling it on a DLQ that already exists with
  // different settings fails outright rather than adopting it.
  let dlqUrl
  try {
    ;({ QueueUrl: dlqUrl } = await client.send(new GetQueueUrlCommand({ QueueName: dlqName })))
    console.log(`DLQ already exists: ${dlqUrl}`)
  } catch (error) {
    if (error.name !== 'QueueDoesNotExist') throw error
    ;({ QueueUrl: dlqUrl } = await client.send(new CreateQueueCommand({ QueueName: dlqName })))
    console.log(`DLQ created: ${dlqUrl}`)
  }

  // The redrive policy references the DLQ by ARN, which only the queue itself
  // can tell us.
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn', 'MessageRetentionPeriod'],
    })
  )

  // Only written when it is actually wrong. A DLQ set up by hand usually
  // already has the retention it needs, and writing it anyway would demand
  // sqs:SetQueueAttributes on a queue this key may only be allowed to read.
  if (Attributes.MessageRetentionPeriod !== String(DLQ_RETENTION_SECONDS)) {
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        Attributes: { MessageRetentionPeriod: String(DLQ_RETENTION_SECONDS) },
      })
    )
    console.log(`DLQ retention set to ${DLQ_RETENTION_SECONDS / 86400} days.`)
  } else {
    console.log(`DLQ retention already ${DLQ_RETENTION_SECONDS / 86400} days.`)
  }

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainQueueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes.QueueArn,
          maxReceiveCount: MAX_RECEIVE_COUNT,
        }),
        VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
      },
    })
  )

  console.log(`Redrive policy set on ${mainQueueName}.`)
  console.log(`Visibility timeout set to ${VISIBILITY_TIMEOUT_SECONDS}s.`)
  console.log(
    `A batch now gets ~${Math.round((MAX_RECEIVE_COUNT * VISIBILITY_TIMEOUT_SECONDS) / 60)} minutes of retries before the DLQ.`
  )
  console.log('\nAdd a CloudWatch alarm on the DLQ\'s ApproximateNumberOfMessages > 0 —')
  console.log('a dead-letter queue nobody watches is a slower way to lose data.')
}

main().catch((error) => {
  console.error('Failed to configure the DLQ:', error.message)
  process.exit(1)
})
