import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { BEDROCK_MODEL_ID, BEDROCK_FOUNDATION_MODEL_ID, BEDROCK_MODEL_ROUTABLE_REGIONS, CLASSIFIER_MODEL_ID } from './config';

export interface RealtimeStackProps extends StackProps {
  connectionsTable: dynamodb.Table;
  requestsTable: dynamodb.Table;
  smallQueue: sqs.Queue;
  mediumQueue: sqs.Queue;
}

export class RealtimeStack extends Stack {
  public readonly webSocketApi: apigwv2.WebSocketApi;
  public readonly stage: apigwv2.WebSocketStage;

  constructor(scope: Construct, id: string, props: RealtimeStackProps) {
    super(scope, id, props);

    const commonNodeProps: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { minify: true, sourceMap: true },
      timeout: Duration.seconds(10),
      logRetention: logs.RetentionDays.TWO_WEEKS,
    };

    const connectFn = new lambdaNode.NodejsFunction(this, 'ConnectFn', {
      ...commonNodeProps,
      entry: 'lambda/connect/index.ts',
      environment: { CONNECTIONS_TABLE: props.connectionsTable.tableName },
    });
    props.connectionsTable.grantWriteData(connectFn);

    const disconnectFn = new lambdaNode.NodejsFunction(this, 'DisconnectFn', {
      ...commonNodeProps,
      entry: 'lambda/disconnect/index.ts',
      environment: { CONNECTIONS_TABLE: props.connectionsTable.tableName },
    });
    props.connectionsTable.grantWriteData(disconnectFn);

    // The router needs a longer timeout than connect/disconnect: on the
    // Bedrock ("large") path it holds the Lambda open for the entire
    // streaming generation, pushing tokens as they arrive.
    const routerFn = new lambdaNode.NodejsFunction(this, 'RouterFn', {
      ...commonNodeProps,
      entry: 'lambda/router/index.ts',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        REQUESTS_TABLE: props.requestsTable.tableName,
        SMALL_QUEUE_URL: props.smallQueue.queueUrl,
        MEDIUM_QUEUE_URL: props.mediumQueue.queueUrl,
      },
    });
    props.requestsTable.grantWriteData(routerFn);
    props.smallQueue.grantSendMessages(routerFn);
    props.mediumQueue.grantSendMessages(routerFn);
    routerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModelWithResponseStream'],
        resources: [
          // The inference profile the router actually calls...
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
          // ...and the underlying foundation model in every region that
          // profile can route to, per `aws bedrock get-inference-profile`.
          ...BEDROCK_MODEL_ROUTABLE_REGIONS.map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
          ),
        ],
      }),
    );
    // Nova Micro semantic classifier - called (near) synchronously on the
    // request path. Unlike Claude Sonnet, Nova Micro supports direct
    // ON_DEMAND invocation in this account/region (confirmed via
    // `aws bedrock-runtime converse`), so no inference profile is needed.
    routerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${CLASSIFIER_MODEL_ID}`],
      }),
    );

    this.webSocketApi = new apigwv2.WebSocketApi(this, 'InferenceWebSocketApi', {
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectIntegration', connectFn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectFn) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration('RouterIntegration', routerFn) },
    });

    this.stage = new apigwv2.WebSocketStage(this, 'ProdStage', {
      webSocketApi: this.webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // Router (and the ECS workers, granted in ComputeStack) need to call
    // back into API Gateway Management API for this specific API/stage.
    const manageConnectionsPolicy = new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [this.formatArn({ service: 'execute-api', resource: this.webSocketApi.apiId, resourceName: `${this.stage.stageName}/POST/@connections/*` })],
    });
    routerFn.addToRolePolicy(manageConnectionsPolicy);
  }
}
