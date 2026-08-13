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

async function main() {
  console.log(`Main queue: ${mainQueueName}`)
  console.log(`DLQ:        ${dlqName}`)
  console.log(`maxReceiveCount: ${MAX_RECEIVE_COUNT} (from lib/sqs.js)\n`)

  if (!apply) {
    console.log('Dry run. Re-run with --apply to create the DLQ and set the redrive policy.')
    return
  }

  const { QueueUrl: dlqUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { MessageRetentionPeriod: String(DLQ_RETENTION_SECONDS) },
    })
  )
  console.log(`DLQ ready: ${dlqUrl}`)

  // The redrive policy references the DLQ by ARN, which only the queue itself
  // can tell us.
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })
  )

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainQueueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes.QueueArn,
          maxReceiveCount: MAX_RECEIVE_COUNT,
        }),
      },
    })
  )

  console.log(`Redrive policy set on ${mainQueueName}.`)
  console.log('\nAdd a CloudWatch alarm on the DLQ\'s ApproximateNumberOfMessages > 0 —')
  console.log('a dead-letter queue nobody watches is a slower way to lose data.')
}

main().catch((error) => {
  console.error('Failed to configure the DLQ:', error.message)
  process.exit(1)
})
