# Tiered Inference Gateway

Tiered Inference Gateway is an AWS CDK application. It routes each prompt to
the cheapest model that can answer it, and streams the answer back to the
client in real time.

The gateway has three tiers:

- **Small tier.** `google/gemma-3-270m-it`, served by vLLM on a single GPU.
  Use this tier for short factual questions and simple lookups.
- **Medium tier.** `google/gemma-3-4b-it`, served by vLLM on a single GPU.
  Use this tier for moderate reasoning and short code.
- **Bedrock tier.** Anthropic Claude Sonnet, served by Amazon Bedrock. Use
  this tier for complex, multi-step, or long-form requests.

Amazon Nova Micro classifies each prompt and picks the tier. The client
gets the answer over a WebSocket connection, one token at a time, as soon
as the model produces it. No result is ever written to S3 or to disk.

A feature flag switches the compute layer between Amazon ECS and Amazon
EKS. Both run the same container image. See [ECS or EKS](#ecs-or-eks).

## Architecture

```
Client --wss--> API Gateway WebSocket API --$connect/$default--> Lambda (connect / router)
                       ^                                              |
                       |                                    classify + enqueue
                       |                                              |
                       |                                   +----------+----------+
                       |                                   |                     |
                       |                             SQS small queue      SQS medium queue
                       |                                   |                     |
                       |                          ECS EC2 service           ECS EC2 service
                       |                          (g6.xlarge, 1 GPU)        (g6.xlarge, 1 GPU)
                       |                          vLLM: gemma-3-270m        vLLM: gemma-3-4b
                       |                                   |                     |
                       +---------- PostToConnection (token by token) -----------+

              Complex prompts skip the queue. The router Lambda calls
              Bedrock directly and streams the reply to the client.
```

### How the router picks a tier

The router Lambda (`lambda/router/index.ts`) checks each request in this
order. Tier thresholds live in `lib/config.ts`.

| Check | Result |
|---|---|
| Request sets `"route": "small"`, `"medium"`, or `"large"` | Use that tier. Skip the classifier. |
| `maxTokens` is above the medium tier's ceiling (2048) | Use the Bedrock tier. The small and medium models cannot produce more tokens than their configured limit. |
| None of the above | Send the prompt to Nova Micro. Nova Micro returns `small`, `medium`, or `large`. |
| Nova Micro fails, or returns something the router cannot parse | Fall back to a rule based on prompt length and `maxTokens`. |

Nova Micro classifies on task complexity, not prompt length. "Write a
sorting algorithm" and "What is the capital of France?" are close in
length but need different tiers; Nova Micro tells them apart. A pure
length rule cannot. See `classifyWithNova` and `classifyHeuristic` in
`lambda/router/index.ts`.

## Why WebSocket, not SSE

Server-Sent Events (SSE) need one open HTTP connection for the full
length of a request. That does not fit this pipeline, for three reasons.

**1. The GPU tiers cold-start in 7 to 20 minutes.** A request passes from
the router Lambda to an SQS queue to an ECS task. At low traffic, that ECS
task does not exist yet; it scales up from zero. An SSE connection cannot
stay open across a Lambda invocation, an SQS visibility window, and an ECS
cold start. Three separate limits would break it: a Lambda invocation
stops after 15 minutes, an API Gateway HTTP API integration times out
after 29 seconds, and an Application Load Balancer closes an idle
connection after 60 seconds by default. A WebSocket connection has none of
these limits, because the client connection and the backend work are two
separate things.

**2. The worker that generates the answer is not the process that
accepted the request.** The router hands the job to a queue. Whichever
ECS task is free picks it up, and that task may start well after the
original HTTP request. There is no live HTTP response to write the answer
into. WebSocket solves this: the router stores the client's
`connectionId` once, in DynamoDB. Any later process, the router Lambda on
the Bedrock path or any ECS task on the vLLM path, reads that
`connectionId` and pushes tokens to the same client through
`PostToConnection`.

**3. WebSocket costs less at this traffic pattern.** API Gateway
WebSocket APIs bill per message and per connection-minute. No Lambda or
EC2 process sits idle holding a connection open during a multi-minute
cold start. An SSE design over an Application Load Balancer would need
long-lived connections proxied through ECS, which uses ALB capacity and
can force GPU tasks to stay warm just to keep idle connections alive.
Connection state here lives in a DynamoDB table (`ConnectionsTable`),
which costs about $0.25 per GB stored and scales without any capacity
planning.

SSE would be simpler for one case: a single, always-on server that proxies
vLLM's own SSE stream directly, with no queue in between. That design
gives up the scale-to-zero GPU capacity and multi-tier routing this
gateway is built around.

### Scaling

Each ECS task runs one worker (`container/worker.py`). The worker
long-polls its tier's SQS queue and processes up to `MAX_MESSAGES_PER_POLL`
requests at once, using `asyncio` and vLLM's continuous batching. Because
each message carries its own `connectionId`, a task can serve many
different clients at once, and ECS tasks scale independently of API
Gateway connections. A task that starts 15 minutes after the original
request still finds the right client to stream to.

## Stacks (`lib/`)

- **`network-stack.ts`.** VPC across 2 availability zones, one NAT
  gateway, and VPC endpoints for S3, DynamoDB, ECR, CloudWatch Logs, SQS,
  SSM, Bedrock, and API Gateway management. GPU instances stay in private
  subnets and do not need broad internet access.
- **`data-stack.ts`.** Two DynamoDB tables, both with a TTL:
  `ConnectionsTable` holds live WebSocket connections, and `RequestsTable`
  maps an in-flight request to its connection and checks for duplicate
  delivery. Neither table stores results. Nothing here is meant to
  outlive one request or one connection.
- **`queue-stack.ts`.** A `small` SQS queue, a `medium` SQS queue, and one
  shared dead-letter queue (`maxReceiveCount` 3).
- **`realtime-stack.ts`.** The WebSocket API (`$connect`, `$disconnect`,
  `$default` routes) and three Lambda functions: `connect`, `disconnect`,
  and `router`. The router validates each request with Zod, classifies it
  with Nova Micro, then either enqueues it or streams the reply from
  Bedrock.
- **`compute-stack.ts`.** An ECS cluster with two EC2 Auto Scaling Group
  capacity providers, one per tier. Each capacity provider scales its GPU
  instances from 0 to N. Two `Ec2Service`s scale their tasks from 0 to N
  based on SQS queue depth.

## Container (`container/`)

The container runs the `vllm/vllm-openai` image with the tier's model,
plus `worker.py`. The worker polls SQS, calls vLLM's local
`/v1/chat/completions` endpoint with `stream=true`, and forwards each
token to the client through `PostToConnection`. Before it starts, the
worker checks `ConnectionsTable` for the client's connection. If the
client has disconnected, generation stops immediately instead of running
to completion and discarding the result.

`MODEL_ID` is a Docker build argument, set per tier in `compute-stack.ts`.
Each tier's image is built for one model. To use a different model, or a
model pre-cached in S3, change `lib/config.ts`.

## ECS or EKS

A feature flag in `bin/app.ts` selects the compute layer:

```bash
npx cdk deploy --all                          # ECS (default)
npx cdk deploy --all -c computePlatform=eks   # EKS
# or: COMPUTE_PLATFORM=eks npx cdk deploy --all
```

The network, data, queue, and realtime stacks are the same for both
platforms. Only the compute stack changes: `lib/compute-stack.ts` for ECS,
or `lib/eks-compute-stack.ts` for EKS. `bin/app.ts` deploys exactly one of
the two.

**Use ECS unless you have a specific reason for Kubernetes**, such as an
existing Kubernetes team, a need to run on another cluster, or an
existing Helm-based deployment pipeline. The EKS path does the same job
with more components to operate and more failure modes to learn. If your
team is new to Kubernetes, that cost is real; ECS's smaller surface area
is the safer default for this workload.

### ECS concepts and their Kubernetes equivalents

ECS bundles container scheduling, task autoscaling, and GPU capacity
management into a few constructs that AWS operates for you:
`Ec2TaskDefinition`, `Ec2Service`, `AsgCapacityProvider`. Kubernetes is a
scheduler only, so the same behavior needs several separate add-ons. This
table maps each ECS concept to its Kubernetes equivalent in this repo.

| ECS concept | Kubernetes equivalent | What it does |
|---|---|---|
| `AsgCapacityProvider` scales GPU instances from 0 to N with task demand | **Karpenter** | Watches for pods that cannot be scheduled because no node has a free GPU, then launches the exact EC2 instance needed. Terminates that instance once nothing runs on it. This is what makes GPU nodes scale to zero. |
| `Ec2Service.autoScaleTaskCount().scaleOnMetric(...)` scales tasks from 0 to N with SQS depth | **KEDA** (`ScaledObject`) | Watches each tier's SQS queue depth and sets the matching `Deployment`'s replica count, down to 0 when the queue is empty. Kubernetes' built-in autoscaler (HPA) cannot scale to zero or read SQS directly; KEDA is the standard add-on that can. |
| ECS task role | **IRSA** (IAM Roles for Service Accounts) | Grants a pod AWS permissions (SQS, DynamoDB, `execute-api:ManageConnections`) without static credentials. Each tier has its own Kubernetes `ServiceAccount`, created by `cluster.addServiceAccount` in CDK and linked to an IAM role. |
| Container instance IAM role | **Karpenter node role** | A separate IAM role that lets an EC2 instance join the cluster. This role is unrelated to what the pods on that instance are allowed to do; IRSA controls that. |
| GPU visible to the ECS scheduler | **NVIDIA device plugin** (`DaemonSet`) | Tells the Kubernetes scheduler that a node has one GPU available. ECS does this automatically; Kubernetes needs this DaemonSet on every GPU node. |
| Tasks placed only on the matching capacity provider | **Taints, tolerations, and node labels** | Keeps each tier's pods on that tier's nodes. Every GPU node carries the taint `nvidia.com/gpu=present:NoSchedule`; only a pod with a matching toleration can be scheduled there. A node label (`inference-tier: small` or `medium`) pins each tier's `Deployment` to its own `NodePool`. |

### Before you deploy on EKS

- Install `kubectl` and `helm` on your machine. CDK installs the Helm
  charts for you at deploy time; you will still want both tools for
  troubleshooting.
- After the deploy finishes, fetch a kubeconfig:
  ```bash
  aws eks update-kubeconfig --name tiered-inference-gateway --region <region>
  ```
  The IAM principal that ran `cdk deploy` is already a cluster admin. EKS
  grants this automatically to the principal that created the cluster.
- Grant the same Bedrock model access, and check the same GPU vCPU quota,
  as the ECS path. See [Deploying](#deploying).

### Check the deploy worked

```bash
kubectl get nodepool                    # 0 nodes until the first request arrives
kubectl -n inference get deployments    # small-vllm, medium-vllm, both at 0/0 replicas when idle
kubectl -n inference get scaledobjects  # KEDA's view of each tier's queue-driven target
kubectl get nodes -L inference-tier     # GPU nodes appear here once Karpenter provisions them
kubectl -n inference logs deploy/small-vllm -c vllm-worker
```

Send a test request with `test/client_test.py` (the same script works for
both platforms). Watch `kubectl -n inference get pods -w`. You should see
a node appear, then a pod scheduled onto it, then tokens arrive over the
WebSocket connection.

### Weaker points of the EKS path

- **Two extra components to patch.** Karpenter and KEDA are
  community-maintained controllers, not AWS-managed services like ECS.
  `KARPENTER_VERSION` and `KEDA_VERSION` are pinned at the top of
  `lib/eks-compute-stack.ts`. Check each project's release notes before
  you raise either version.
- **The Karpenter controller IAM policy is hand-adapted.** No CDK
  construct generates it yet. `installKarpenter()` in
  `lib/eks-compute-stack.ts` adapts it from Karpenter's own
  getting-started policy. If you raise `KARPENTER_VERSION` across a major
  version, compare it against
  <https://karpenter.sh/docs/reference/cloudformation/>.
- **The EKS API endpoint is public.** `EndpointAccess.PUBLIC` avoids a
  stack dependency cycle between the VPC stack and the cluster stack; see
  the comment in `eks-compute-stack.ts` for the detail. The endpoint still
  needs an IAM identity and a valid certificate, but this is a wider
  network exposure than ECS, where nothing but the WebSocket API is
  internet-facing.
- **KEDA's SQS authentication depends on one implementation detail.** The
  `TriggerAuthentication` resource uses
  `podIdentity: { provider: aws-eks, identityOwner: pod }` so KEDA reuses
  each tier's own IRSA role, instead of granting the KEDA operator its own
  AWS permissions. This depends on KEDA 2.20's `podIdentity` behavior.
  Check <https://keda.sh/docs/2.20/scalers/aws-sqs/> before you raise
  `KEDA_VERSION`.

## Deploying

```bash
npm install
npx cdk bootstrap   # once per account and region
npx cdk deploy --all
```

Before you deploy:

1. Grant access to both Bedrock models in the Bedrock console, for your
   target region: `BEDROCK_MODEL_ID` (the Bedrock tier) and
   `CLASSIFIER_MODEL_ID` (Nova Micro routing), both in `lib/config.ts`.
   Some regions expose Nova Micro only through a cross-region inference
   profile ARN, not the bare `amazon.nova-micro-v1:0` model ID.
2. Check your account's GPU vCPU quota for the instance types in
   `SMALL_TIER` and `MEDIUM_TIER` (`lib/config.ts`). Request a quota
   increase if needed; approval can take time.
3. Review `SMALL_TIER` and `MEDIUM_TIER` in `lib/config.ts`: instance
   type, model ID, prompt and token thresholds, and min/max scaling. Raise
   a tier's `min` above 0 if a 7- to 20-minute cold start does not work
   for your use case.

`cdk synth --all` runs clean for both `computePlatform` values. Building
and pushing the container images needs Docker; that step runs at `cdk
deploy` time (asset publishing), not at `cdk synth` time.

## Testing

```bash
pip install -r test/requirements.txt
python3 test/client_test.py wss://<api-id>.execute-api.<region>.amazonaws.com/prod \
  --prompt "Explain the CAP theorem in two sentences."
```

The client prints tokens as they arrive. Pass `--route small`, `--route
medium`, or `--route large` to force a tier and check routing end to end.
