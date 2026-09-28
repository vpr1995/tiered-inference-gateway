#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { QueueStack } from '../lib/queue-stack';
import { RealtimeStack } from '../lib/realtime-stack';
import { ComputeStack } from '../lib/compute-stack';
import { EksComputeStack } from '../lib/eks-compute-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// --- Feature flag: which orchestrator runs the GPU inference workers? ---
// Set via `-c computePlatform=eks` on the CDK CLI, or the COMPUTE_PLATFORM
// env var (CLI context wins if both are set). Defaults to ECS - only
// switch to EKS if you specifically want Kubernetes; see the "EKS path"
// section of README.md first if you haven't used Kubernetes before, it's
// meaningfully more operationally complex than the ECS path.
const computePlatform = (app.node.tryGetContext('computePlatform') ?? process.env.COMPUTE_PLATFORM ?? 'ecs')
  .toString()
  .toLowerCase();

if (computePlatform !== 'ecs' && computePlatform !== 'eks') {
  throw new Error(`computePlatform must be "ecs" or "eks", got "${computePlatform}"`);
}

const network = new NetworkStack(app, 'InferenceNetworkStack', { env });
const data = new DataStack(app, 'InferenceDataStack', { env });
const queues = new QueueStack(app, 'InferenceQueueStack', { env });

const realtime = new RealtimeStack(app, 'InferenceRealtimeStack', {
  env,
  connectionsTable: data.connectionsTable,
  requestsTable: data.requestsTable,
  smallQueue: queues.queues['small'],
  mediumQueue: queues.queues['medium'],
});

const computeProps = {
  env,
  vpc: network.vpc,
  requestsTable: data.requestsTable,
  connectionsTable: data.connectionsTable,
  queues: queues.queues,
  webSocketApi: realtime.webSocketApi,
  webSocketStage: realtime.stage,
};

if (computePlatform === 'eks') {
  new EksComputeStack(app, 'InferenceEksComputeStack', computeProps);
} else {
  new ComputeStack(app, 'InferenceComputeStack', computeProps);
}
