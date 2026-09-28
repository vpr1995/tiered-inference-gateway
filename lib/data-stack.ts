import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Ephemeral routing state only - NOT a results store. Nothing here is meant
 * to persist beyond the lifetime of a single request/connection; both tables
 * use TTL so rows expire automatically. Final answers are never written to
 * S3/Dynamo for later retrieval - they are streamed straight to the client
 * over the WebSocket connection (see RealtimeStack + container/worker.py).
 */
export class DataStack extends Stack {
  public readonly connectionsTable: dynamodb.Table;
  public readonly requestsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Maps an in-flight requestId -> the connectionId that should receive
    // streamed tokens for it. Workers running on ECS (which have no direct
    // relationship to the API Gateway connection) look this up before every
    // PostToConnection call, and also to detect a client that disconnected
    // mid-generation so they can stop early instead of wasting GPU time.
    this.requestsTable = new dynamodb.Table(this, 'RequestsTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
