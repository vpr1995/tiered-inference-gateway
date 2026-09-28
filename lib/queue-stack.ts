import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SMALL_TIER, MEDIUM_TIER, TierConfig } from './config';

export class QueueStack extends Stack {
  public readonly dlq: sqs.Queue;
  public readonly queues: Record<string, sqs.Queue> = {};

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.dlq = new sqs.Queue(this, 'InferenceDlq', {
      retentionPeriod: Duration.days(14),
    });

    for (const tier of [SMALL_TIER, MEDIUM_TIER] as TierConfig[]) {
      this.queues[tier.name] = new sqs.Queue(this, `${tier.name}Queue`, {
        // Long enough for a worst-case cold-start scale-up + generation for
        // this tier's model size; short enough that a stuck task doesn't
        // black-hole a message for too long before it's retried.
        visibilityTimeout: Duration.seconds(tier.name === 'small' ? 300 : 600),
        retentionPeriod: Duration.hours(6),
        deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
        receiveMessageWaitTime: Duration.seconds(20), // long polling
      });
    }
  }
}
