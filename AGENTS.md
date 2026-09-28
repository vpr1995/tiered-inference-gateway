# AGENTS.md

Guidance for AI coding agents working in this repo. Humans: see `README.md`.

## What this is

An AWS CDK (TypeScript) app. It routes prompts across three tiers (small:
Gemma 3 270M, medium: Gemma 3 4B, both on vLLM/ECS or EKS; large: Amazon
Bedrock) and streams tokens back over a WebSocket API. No REST endpoints,
no S3 results store.

## Source of truth

- `lib/config.ts` — tier definitions (model ID, instance type, prompt/token
  thresholds, min/max scaling), `BEDROCK_MODEL_ID`, `CLASSIFIER_MODEL_ID`.
  Change tier behavior here, not by hardcoding values in stacks or Lambdas.
- `bin/app.ts` — wires all stacks and holds the `computePlatform` feature
  flag (`ecs` | `eks`). Both compute stacks take the same props interface;
  keep it that way if you touch either.
- `lambda/router/index.ts` — request validation (Zod) and tier
  classification (Nova Micro, with a length-heuristic fallback). This is
  the one place routing logic lives; don't duplicate it in the container.
- `container/worker.py` — the only consumer of each SQS queue. Same image
  runs under both ECS and EKS; don't fork it per platform.

## Before you change anything

1. Run `npx tsc --noEmit -p tsconfig.json` — must be clean.
2. Run `npx cdk synth --all` **and** `npx cdk synth --all -c
   computePlatform=eks` — both must synth clean. This repo has no Docker
   in CI/dev sandboxes by default, so synth (not deploy) is the
   verification bar; note that explicitly if you couldn't run a real
   deploy.
3. If you touch `lambda/router/index.ts` or `lib/config.ts`, check that
   IAM resources in `lib/realtime-stack.ts` / `lib/compute-stack.ts` /
   `lib/eks-compute-stack.ts` still match (e.g. Bedrock model ARNs,
   inference profile IDs — Claude Sonnet 4.5 requires an inference
   profile, not a bare model ID; verified against a real account, don't
   revert it).

## Conventions

- One term per concept, everywhere: "tier", "router", "worker", "queue".
  Don't introduce synonyms for these in new code or docs.
- ECS and EKS compute stacks must stay swappable: same `props` shape, same
  DynamoDB/SQS/WebSocket dependencies passed in from `bin/app.ts`, no
  ECS-only or EKS-only fields leaking into shared stacks.
- Real-time delivery only. Don't add S3 (or any other) persistent results
  store — that was an explicit design decision, not an oversight.
- Prefer Zod schemas over hand-rolled validation in Lambda handlers.
- Pinned versions (`KARPENTER_VERSION`, `KEDA_VERSION` in
  `lib/eks-compute-stack.ts`, container base image tag) are deliberate.
  Bump them only when asked, and check the linked release notes in the
  surrounding comment first.

## Known constraints (verified against a live AWS account, don't "fix")

- `BEDROCK_MODEL_ID` is an inference profile ID
  (`us.anthropic.claude-sonnet-4-5-...`), not a bare foundation-model ID.
- `EksComputeStack`'s cluster `endpointAccess` is `PUBLIC` and its
  `clusterName` is a literal string, not read from `cluster.clusterName`.
  Both avoid a real CDK cross-stack dependency cycle between the VPC stack
  and the EKS stack — see the inline comments before changing either.

## Don't

- Don't add `--no-verify`, skip hooks, or bypass Zod validation to make a
  test pass.
- Don't hardcode an AWS account ID, region, or ARN outside of
  `this.account` / `this.region` / CDK context.
- Don't assume Docker is available; container image builds only happen at
  `cdk deploy` time (asset publishing), not at `cdk synth`.
