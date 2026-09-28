import { Stack, StackProps, Duration, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { TierConfig, SMALL_TIER, MEDIUM_TIER } from './config';

/**
 * EKS alternative to compute-stack.ts, picked via the COMPUTE_PLATFORM
 * feature flag in bin/app.ts. Runs the exact same container image
 * (container/) as the ECS path, just orchestrated by Kubernetes instead:
 *
 *   - Karpenter provisions/terminates the GPU EC2 nodes themselves
 *     (the Kubernetes equivalent of the ECS ASG capacity providers),
 *     including scaling to zero nodes when idle.
 *   - KEDA scales each tier's Deployment 0->N pods based on that tier's
 *     SQS queue depth (the Kubernetes equivalent of Ec2Service
 *     .autoScaleTaskCount().scaleOnMetric(...) in compute-stack.ts).
 *   - Each tier's pods run under their own IRSA-backed ServiceAccount,
 *     the Kubernetes equivalent of an ECS task role.
 *
 * If you've never used Kubernetes: Karpenter and KEDA are the two
 * "autoscalers" doing the job ECS's capacity providers + service
 * autoscaling did for you automatically. IRSA (IAM Roles for Service
 * Accounts) is how a pod gets AWS permissions, the direct analog of an
 * ECS task role. Read the "EKS path" section of README.md before you
 * touch this file - it explains every moving part in plain English.
 */

// Pin Helm chart versions explicitly (both projects move fast). Check
// https://github.com/aws/karpenter-provider-aws/releases and
// https://github.com/kedacore/charts/releases for newer versions before
// deploying, and re-pin deliberately rather than tracking "latest".
const KARPENTER_VERSION = '1.8.0';
const KEDA_VERSION = '2.20.0';
const KUBERNETES_VERSION = eks.KubernetesVersion.V1_31;

const GPU_TAINT_KEY = 'nvidia.com/gpu';
const GPU_NODE_LABEL = { key: 'workload-type', value: 'gpu-inference' };
const INFERENCE_NAMESPACE = 'inference';
// A plain compile-time string, never re-read from `cluster.clusterName`
// (see the comment on the `clusterName` cluster prop below for why).
const CLUSTER_NAME = 'tiered-inference-gateway';

export interface EksComputeStackProps extends StackProps {
  vpc: ec2.Vpc;
  requestsTable: dynamodb.Table;
  connectionsTable: dynamodb.Table;
  queues: Record<string, sqs.Queue>;
  webSocketApi: apigwv2.WebSocketApi;
  webSocketStage: apigwv2.WebSocketStage;
}

export class EksComputeStack extends Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EksComputeStackProps) {
    super(scope, id, props);

    this.cluster = new eks.Cluster(this, 'InferenceEksCluster', {
      // A plain string constant, deliberately, and read back via
      // CLUSTER_NAME everywhere below rather than `this.cluster
      // .clusterName`: several places tag NetworkStack-owned subnets for
      // Karpenter's discovery mechanism, and `cluster.clusterName` is a
      // CDK token even when you pass an explicit name (it's implemented
      // as a Ref-backed attribute for consistency). Tagging another
      // stack's resources with that token would force NetworkStack to
      // import an output from this stack, which - combined with this
      // stack already importing the VPC from NetworkStack - is a real
      // dependency cycle CDK will reject at synth time.
      clusterName: CLUSTER_NAME,
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      version: KUBERNETES_VERSION,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
      defaultCapacity: 0, // no default node group - Karpenter brings all GPU capacity
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      // Public-only endpoint (still IAM+cert authenticated) keeps CDK's
      // kubectl handler Lambda (which does the Helm/manifest installs
      // below) out of the VPC entirely. That sidesteps a real dependency
      // cycle: the VPC lives in NetworkStack, a separate stack, and a
      // private/mixed endpoint forces the handler's ENIs into that VPC,
      // which CDK can't resolve across the two stacks in this app's
      // topology. It also means `kubectl` works straight from your laptop
      // with no bastion/VPN. Tighten to PUBLIC_AND_PRIVATE later if you
      // fold the VPC and cluster into one stack.
      endpointAccess: eks.EndpointAccess.PUBLIC,
    });

    const namespace = this.cluster.addManifest('InferenceNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: INFERENCE_NAMESPACE },
    });

    const nodeRole = this.buildKarpenterNodeRole();
    const karpenterSA = this.installKarpenter(nodeRole);
    this.installNvidiaDevicePlugin(karpenterSA);
    this.installKeda();

    for (const tier of [SMALL_TIER, MEDIUM_TIER]) {
      this.buildTier(tier, props, namespace, karpenterSA);
    }
  }

  /** IAM role EC2 nodes launched by Karpenter assume - the node-side analog of the ECS ASG's instance role. */
  private buildKarpenterNodeRole(): iam.Role {
    const role = new iam.Role(this, 'KarpenterNodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Karpenter-launched nodes still authenticate to the Kubernetes API the
    // same way any EKS worker node does - via this aws-auth mapping. This
    // step trips people up the most when following Karpenter's docs
    // manually; CDK's awsAuth helper does it in one call.
    this.cluster.awsAuth.addRoleMapping(role, {
      groups: ['system:bootstrappers', 'system:nodes'],
      username: 'system:node:{{EC2PrivateDNSName}}',
    });

    return role;
  }

  /**
   * Installs the Karpenter controller (Helm) plus its IRSA role. Policy
   * adapted from Karpenter's official getting-started IAM policy - re-check
   * https://karpenter.sh/docs/reference/cloudformation/ if you bump
   * KARPENTER_VERSION across a major line.
   */
  private installKarpenter(nodeRole: iam.Role): eks.ServiceAccount {
    for (const subnet of this.cluster.vpc.privateSubnets) {
      Tags.of(subnet).add('karpenter.sh/discovery', CLUSTER_NAME);
    }
    for (const sg of this.cluster.connections.securityGroups) {
      Tags.of(sg).add('karpenter.sh/discovery', CLUSTER_NAME);
    }

    const karpenterSA = this.cluster.addServiceAccount('KarpenterControllerSA', {
      name: 'karpenter',
      namespace: 'kube-system',
    });

    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowScopedEC2InstanceAccessActions',
      actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
      resources: [
        `arn:aws:ec2:${this.region}::image/*`,
        `arn:aws:ec2:${this.region}::snapshot/*`,
        `arn:aws:ec2:${this.region}:*:security-group/*`,
        `arn:aws:ec2:${this.region}:*:subnet/*`,
        `arn:aws:ec2:${this.region}:*:launch-template/*`,
      ],
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowScopedEC2LaunchTemplateActions',
      actions: ['ec2:RunInstances', 'ec2:CreateFleet', 'ec2:CreateLaunchTemplate'],
      resources: [
        `arn:aws:ec2:${this.region}:*:fleet/*`,
        `arn:aws:ec2:${this.region}:*:instance/*`,
        `arn:aws:ec2:${this.region}:*:volume/*`,
        `arn:aws:ec2:${this.region}:*:network-interface/*`,
        `arn:aws:ec2:${this.region}:*:launch-template/*`,
        `arn:aws:ec2:${this.region}:*:spot-instances-request/*`,
      ],
      conditions: {
        StringEquals: { [`aws:RequestTag/kubernetes.io/cluster/${CLUSTER_NAME}`]: 'owned' },
        StringLike: { 'aws:RequestTag/karpenter.sh/nodepool': '*' },
      },
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowScopedResourceCreationTagging',
      actions: ['ec2:CreateTags'],
      resources: [
        `arn:aws:ec2:${this.region}:*:fleet/*`,
        `arn:aws:ec2:${this.region}:*:instance/*`,
        `arn:aws:ec2:${this.region}:*:volume/*`,
        `arn:aws:ec2:${this.region}:*:network-interface/*`,
        `arn:aws:ec2:${this.region}:*:launch-template/*`,
      ],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': ['RunInstances', 'CreateFleet', 'CreateLaunchTemplate'],
          [`aws:RequestTag/kubernetes.io/cluster/${CLUSTER_NAME}`]: 'owned',
        },
      },
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowScopedDeletion',
      actions: ['ec2:TerminateInstances', 'ec2:DeleteLaunchTemplate'],
      resources: [`arn:aws:ec2:${this.region}:*:instance/*`, `arn:aws:ec2:${this.region}:*:launch-template/*`],
      conditions: {
        StringEquals: { [`aws:ResourceTag/kubernetes.io/cluster/${CLUSTER_NAME}`]: 'owned' },
      },
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowRegionalReadActions',
      actions: [
        'ec2:DescribeCapacityReservations', 'ec2:DescribeImages', 'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypeOfferings', 'ec2:DescribeInstanceTypes', 'ec2:DescribeLaunchTemplates',
        'ec2:DescribeSecurityGroups', 'ec2:DescribeSpotPriceHistory', 'ec2:DescribeSubnets',
      ],
      resources: ['*'],
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowSSMReadActions',
      actions: ['ssm:GetParameter'],
      resources: ['arn:aws:ssm:*::parameter/aws/service/*'],
    }));
    // pricing:GetProducts only exists in us-east-1's Pricing API even though
    // Karpenter calls it from any region - do not add a region condition here.
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowPricingReadActions',
      actions: ['pricing:GetProducts'],
      resources: ['*'],
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowInstanceProfileActions',
      actions: [
        'iam:CreateInstanceProfile', 'iam:TagInstanceProfile', 'iam:AddRoleToInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile',
        'iam:ListInstanceProfiles',
      ],
      resources: [`arn:aws:iam::${this.account}:instance-profile/*`],
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowPassingInstanceRole',
      actions: ['iam:PassRole'],
      resources: [nodeRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    }));
    karpenterSA.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AllowAPIServerEndpointDiscovery',
      actions: ['eks:DescribeCluster'],
      resources: [this.cluster.clusterArn],
    }));

    const karpenterChart = this.cluster.addHelmChart('Karpenter', {
      repository: 'oci://public.ecr.aws/karpenter/karpenter',
      chart: 'karpenter',
      release: 'karpenter',
      namespace: 'kube-system',
      version: KARPENTER_VERSION,
      wait: true,
      timeout: Duration.minutes(15),
      values: {
        settings: { clusterName: CLUSTER_NAME },
        serviceAccount: { create: false, name: karpenterSA.serviceAccountName },
      },
    });
    karpenterChart.node.addDependency(karpenterSA);

    // EC2NodeClass: shared AMI/networking template for every GPU node,
    // regardless of which tier's NodePool provisions it.
    const nodeClass = {
      apiVersion: 'karpenter.k8s.aws/v1',
      kind: 'EC2NodeClass',
      metadata: { name: 'gpu-nodes' },
      spec: {
        amiFamily: 'AL2023',
        // `alias` (not a raw AMI id/SSM path) is what makes Karpenter
        // auto-select the *accelerated* AL2023 variant and inject the
        // right scheduling requirements when a NodePool asks for a GPU
        // instance type - see README's EKS section before changing this.
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        role: nodeRole.roleName,
        subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': CLUSTER_NAME } }],
        securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': CLUSTER_NAME } }],
      },
    };
    const nodeClassManifest = this.cluster.addManifest('GpuNodeClass', nodeClass);
    nodeClassManifest.node.addDependency(karpenterChart);

    return karpenterSA;
  }

  /**
   * DaemonSet advertising `nvidia.com/gpu` as an allocatable resource on
   * every GPU node - without this, pods requesting a GPU in
   * resources.limits will never schedule even once a node exists.
   */
  private installNvidiaDevicePlugin(dependsOn: eks.ServiceAccount) {
    const manifest = this.cluster.addManifest('NvidiaDevicePlugin', {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'nvidia-device-plugin-daemonset', namespace: 'kube-system' },
      spec: {
        selector: { matchLabels: { name: 'nvidia-device-plugin-ds' } },
        template: {
          metadata: { labels: { name: 'nvidia-device-plugin-ds' } },
          spec: {
            nodeSelector: { [GPU_NODE_LABEL.key]: GPU_NODE_LABEL.value },
            tolerations: [
              { key: GPU_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' },
              { key: 'CriticalAddonsOnly', operator: 'Exists' },
            ],
            priorityClassName: 'system-node-critical',
            containers: [
              {
                name: 'nvidia-device-plugin-ctr',
                image: 'nvcr.io/nvidia/k8s-device-plugin:v0.16.2',
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'device-plugin', mountPath: '/var/lib/kubelet/device-plugins' }],
              },
            ],
            volumes: [{ name: 'device-plugin', hostPath: { path: '/var/lib/kubelet/device-plugins' } }],
          },
        },
      },
    });
    manifest.node.addDependency(dependsOn);
  }

  /** KEDA operator (Helm) - no IRSA needed on the operator itself; the SQS
   * scaler authenticates as the *scaled workload's* own pod identity
   * (see buildTier's TriggerAuthentication), not the operator's. */
  private installKeda() {
    this.cluster.addHelmChart('Keda', {
      repository: 'https://kedacore.github.io/charts',
      chart: 'keda',
      release: 'keda',
      namespace: 'keda',
      createNamespace: true,
      version: KEDA_VERSION,
      wait: true,
      timeout: Duration.minutes(10),
    });
  }

  private buildTier(
    tier: TierConfig,
    props: EksComputeStackProps,
    namespace: eks.KubernetesManifest,
    karpenterSA: eks.ServiceAccount,
  ) {
    const queue = props.queues[tier.name];
    const vcpuPerInstance = 4; // g6.xlarge

    const nodePool = this.cluster.addManifest(`${tier.name}NodePool`, {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: `${tier.name}-pool` },
      spec: {
        template: {
          metadata: {
            labels: { [GPU_NODE_LABEL.key]: GPU_NODE_LABEL.value, 'inference-tier': tier.name },
          },
          spec: {
            nodeClassRef: { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'gpu-nodes' },
            taints: [{ key: GPU_TAINT_KEY, value: 'present', effect: 'NoSchedule' }],
            requirements: [
              { key: 'node.kubernetes.io/instance-type', operator: 'In', values: [tier.instanceType] },
              { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
            ],
          },
        },
        // Bounds max concurrent nodes for this tier - the Kubernetes analog
        // of `max` in lib/config.ts for the ECS capacity provider.
        limits: { cpu: String(tier.max * vcpuPerInstance) },
      },
    });
    nodePool.node.addDependency(karpenterSA);

    const serviceAccount = this.cluster.addServiceAccount(`${tier.name}WorkerSA`, {
      name: `${tier.name}-worker`,
      namespace: INFERENCE_NAMESPACE,
    });
    serviceAccount.node.addDependency(namespace);

    queue.grantConsumeMessages(serviceAccount.role);
    props.requestsTable.grantReadWriteData(serviceAccount.role);
    props.connectionsTable.grantReadData(serviceAccount.role);
    serviceAccount.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [
        this.formatArn({
          service: 'execute-api',
          resource: props.webSocketApi.apiId,
          resourceName: `${props.webSocketStage.stageName}/POST/@connections/*`,
        }),
      ],
    }));

    const image = new DockerImageAsset(this, `${tier.name}Image`, {
      directory: path.join(__dirname, '..', 'container'),
      buildArgs: { MODEL_ID: tier.modelId },
    });

    const deployment = this.cluster.addManifest(`${tier.name}Deployment`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `${tier.name}-vllm`, namespace: INFERENCE_NAMESPACE },
      spec: {
        // Starts at 0 - KEDA's ScaledObject owns replica count from here on.
        replicas: 0,
        selector: { matchLabels: { app: `${tier.name}-vllm` } },
        template: {
          metadata: { labels: { app: `${tier.name}-vllm` } },
          spec: {
            serviceAccountName: serviceAccount.serviceAccountName,
            nodeSelector: { [GPU_NODE_LABEL.key]: GPU_NODE_LABEL.value, 'inference-tier': tier.name },
            tolerations: [{ key: GPU_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' }],
            containers: [
              {
                name: 'vllm-worker',
                image: image.imageUri,
                ports: [{ containerPort: 8000 }],
                env: [
                  { name: 'MODEL_ID', value: tier.modelId },
                  { name: 'TIER_NAME', value: tier.name },
                  { name: 'QUEUE_URL', value: queue.queueUrl },
                  { name: 'REQUESTS_TABLE', value: props.requestsTable.tableName },
                  { name: 'CONNECTIONS_TABLE', value: props.connectionsTable.tableName },
                ],
                resources: {
                  limits: { [GPU_TAINT_KEY]: '1' },
                  requests: { cpu: '3', memory: '12Gi' },
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  initialDelaySeconds: 120,
                  periodSeconds: 15,
                  failureThreshold: 40, // ~10 min cold-start budget for model load, mirrors ECS healthCheck.startPeriod
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  initialDelaySeconds: 600,
                  periodSeconds: 30,
                },
              },
            ],
          },
        },
      },
    });
    deployment.node.addDependency(serviceAccount, nodePool);

    const triggerAuth = this.cluster.addManifest(`${tier.name}TriggerAuth`, {
      apiVersion: 'keda.sh/v1alpha1',
      kind: 'TriggerAuthentication',
      metadata: { name: `${tier.name}-sqs-auth`, namespace: INFERENCE_NAMESPACE },
      spec: {
        // identityOwner: pod -> KEDA reads this trigger's credentials from
        // the *scaled workload's own* ServiceAccount (serviceAccount above),
        // reusing the SQS grants already made to it - not a separate
        // identity on the KEDA operator.
        podIdentity: { provider: 'aws-eks', identityOwner: 'pod' },
      },
    });

    const scaledObject = this.cluster.addManifest(`${tier.name}ScaledObject`, {
      apiVersion: 'keda.sh/v1alpha1',
      kind: 'ScaledObject',
      metadata: { name: `${tier.name}-scaledobject`, namespace: INFERENCE_NAMESPACE },
      spec: {
        scaleTargetRef: { name: `${tier.name}-vllm` },
        minReplicaCount: 0,
        maxReplicaCount: tier.max,
        pollingInterval: 15,
        cooldownPeriod: 300,
        triggers: [
          {
            type: 'aws-sqs-queue',
            metadata: {
              queueURL: queue.queueUrl,
              awsRegion: this.region,
              queueLength: String(tier.messagesPerTask),
            },
            authenticationRef: { name: `${tier.name}-sqs-auth` },
          },
        ],
      },
    });
    triggerAuth.node.addDependency(deployment);
    scaledObject.node.addDependency(triggerAuth);
  }
}
