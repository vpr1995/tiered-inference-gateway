import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { TierConfig, SMALL_TIER, MEDIUM_TIER } from './config';

export interface ComputeStackProps extends StackProps {
  vpc: ec2.Vpc;
  requestsTable: dynamodb.Table;
  connectionsTable: dynamodb.Table;
  queues: Record<string, sqs.Queue>;
  webSocketApi: apigwv2.WebSocketApi;
  webSocketStage: apigwv2.WebSocketStage;
}

export class ComputeStack extends Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'InferenceCluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    const manageConnectionsArn = this.formatArn({
      service: 'execute-api',
      resource: props.webSocketApi.apiId,
      resourceName: `${props.webSocketStage.stageName}/POST/@connections/*`,
    });

    for (const tier of [SMALL_TIER, MEDIUM_TIER]) {
      this.buildTier(cluster, tier, props, manageConnectionsArn);
    }
  }

  private buildTier(
    cluster: ecs.Cluster,
    tier: TierConfig,
    props: ComputeStackProps,
    manageConnectionsArn: string,
  ) {
    const queue = props.queues[tier.name];

    // --- GPU capacity: EC2 Auto Scaling Group + ECS managed-scaling capacity
    // provider. Instances scale with task demand and can scale to zero when
    // the tier is idle, so you only pay for GPU time you actually use.
    const asg = new autoscaling.AutoScalingGroup(this, `${tier.name}Asg`, {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(tier.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
      minCapacity: 0,
      maxCapacity: tier.max,
      newInstancesProtectedFromScaleIn: false,
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, `${tier.name}CapacityProvider`, {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: true,
      targetCapacityPercent: 100,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 2,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    // --- Task definition: vLLM OpenAI-compatible server + SQS worker
    // sidecar, running in the same task so the worker can reach vLLM on
    // localhost. See container/ for the image source.
    const taskDefinition = new ecs.Ec2TaskDefinition(this, `${tier.name}TaskDef`);

    queue.grantConsumeMessages(taskDefinition.taskRole);
    props.requestsTable.grantReadWriteData(taskDefinition.taskRole);
    props.connectionsTable.grantReadData(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [manageConnectionsArn],
      }),
    );

    const logGroup = new logs.LogGroup(this, `${tier.name}LogGroup`, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer(`${tier.name}Container`, {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', 'container'), {
        buildArgs: { MODEL_ID: tier.modelId },
      }),
      gpuCount: 1,
      memoryReservationMiB: 12288,
      cpu: 4096,
      environment: {
        MODEL_ID: tier.modelId,
        TIER_NAME: tier.name,
        QUEUE_URL: queue.queueUrl,
        REQUESTS_TABLE: props.requestsTable.tableName,
        CONNECTIONS_TABLE: props.connectionsTable.tableName,
      },
      portMappings: [{ containerPort: 8000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: tier.name, logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        startPeriod: Duration.minutes(10), // model load / cold start
        retries: 3,
      },
    });

    const service = new ecs.Ec2Service(this, `${tier.name}Service`, {
      cluster,
      taskDefinition,
      desiredCount: 0,
      capacityProviderStrategies: [{ capacityProvider: capacityProvider.capacityProviderName, weight: 1 }],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });

    const scaling = service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: tier.max });
    scaling.scaleOnMetric(`${tier.name}QueueDepthScaling`, {
      metric: queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.seconds(90),
      scalingSteps: [
        { upper: 0, change: -1 }, // queue drained -> scale back down, eventually to zero
        { lower: 1, change: 0 },
        { lower: tier.messagesPerTask, change: +1 },
        { lower: tier.messagesPerTask * 4, change: +2 },
      ],
    });
  }
}
