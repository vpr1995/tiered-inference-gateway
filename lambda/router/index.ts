import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { SMALL_TIER, MEDIUM_TIER, BEDROCK_MODEL_ID, CLASSIFIER_MODEL_ID } from '../../lib/config';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const bedrock = new BedrockRuntimeClient({});

const REQUESTS_TABLE = process.env.REQUESTS_TABLE!;
const SMALL_QUEUE_URL = process.env.SMALL_QUEUE_URL!;
const MEDIUM_QUEUE_URL = process.env.MEDIUM_QUEUE_URL!;

type Tier = 'small' | 'medium' | 'bedrock';

// z.coerce.number() keeps the previous leniency (a client that sends
// maxTokens as "512" still works), everything else is rejected up front by
// Zod with a precise, per-field message instead of hand-rolled ifs.
const InferRequestSchema = z.object({
  prompt: z
    .string({ required_error: '"prompt" is required and must be a non-empty string' })
    .trim()
    .min(1, '"prompt" is required and must be a non-empty string')
    .max(8000, '"prompt" exceeds the 8000 character limit'),
  maxTokens: z.coerce
    .number()
    .int('"maxTokens" must be an integer between 1 and 4096')
    .min(1, '"maxTokens" must be an integer between 1 and 4096')
    .max(4096, '"maxTokens" must be an integer between 1 and 4096')
    .default(512),
  temperature: z.coerce
    .number()
    .min(0, '"temperature" must be a number between 0 and 2')
    .max(2, '"temperature" must be a number between 0 and 2')
    .default(0.7),
  topP: z.coerce
    .number()
    .min(0, '"topP" must be a number between 0 and 1')
    .max(1, '"topP" must be a number between 0 and 1')
    .default(1),
  route: z.enum(['small', 'medium', 'large'], { message: '"route" must be one of small | medium | large' }).optional(),
});
type InferRequest = z.infer<typeof InferRequestSchema>;

function validate(body: unknown): { ok: true; req: InferRequest } | { ok: false; error: string } {
  const result = InferRequestSchema.safeParse(body);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, req: result.data };
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a tiered LLM inference pipeline. Classify the user's prompt into exactly one tier based on the reasoning/generation complexity it requires:
- small: simple factual questions, short lookups, basic classification/extraction, casual chat - answerable in a few sentences.
- medium: moderate reasoning, summarization, short code snippets, multi-step but bounded tasks.
- large: complex multi-step reasoning, non-trivial code generation, long-form writing, deep analysis, or anything ambiguous/high-stakes.

Reply with exactly one word - small, medium, or large - and nothing else.`;

async function classifyWithNova(prompt: string): Promise<Tier> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: CLASSIFIER_MODEL_ID,
      system: [{ text: CLASSIFIER_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: prompt.slice(0, 4000) }] }],
      inferenceConfig: { maxTokens: 5, temperature: 0 },
    }),
  );
  const text = (response.output?.message?.content?.[0]?.text ?? '').trim().toLowerCase();
  if (text.startsWith('small')) return 'small';
  if (text.startsWith('medium')) return 'medium';
  if (text.startsWith('large')) return 'bedrock';
  throw new Error(`unrecognized classifier output: "${text}"`);
}

function classifyHeuristic(req: InferRequest): Tier {
  const chars = req.prompt.length;
  if (chars <= SMALL_TIER.maxPromptChars && req.maxTokens <= SMALL_TIER.maxTokensCeiling) return 'small';
  if (chars <= MEDIUM_TIER.maxPromptChars && req.maxTokens <= MEDIUM_TIER.maxTokensCeiling) return 'medium';
  return 'bedrock';
}

async function classify(req: InferRequest): Promise<Tier> {
  if (req.route === 'large') return 'bedrock';
  if (req.route === 'small') return 'small';
  if (req.route === 'medium') return 'medium';

  // Hard clamp before spending a classifier call: our self-hosted tiers
  // can't be forced to emit more tokens than they're configured for, no
  // matter what Nova thinks of the prompt's complexity.
  if (req.maxTokens > MEDIUM_TIER.maxTokensCeiling) return 'bedrock';

  try {
    return await classifyWithNova(req.prompt);
  } catch (err) {
    console.error('Nova Micro classification failed, falling back to length heuristic', err);
    return classifyHeuristic(req);
  }
}

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  const post = async (payload: unknown) => {
    try {
      await apiGw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify(payload)),
        }),
      );
    } catch (err) {
      if (err instanceof GoneException) return; // client disconnected, nothing to do
      throw err;
    }
  };

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '{}');
  } catch {
    await post({ type: 'error', error: 'body must be valid JSON' });
    return { statusCode: 200, body: 'invalid json' };
  }

  const validation = validate(parsedBody);
  if (!validation.ok) {
    await post({ type: 'error', error: validation.error });
    return { statusCode: 200, body: 'validation failed' };
  }
  const req = validation.req;
  const tier = await classify(req);
  const requestId = randomUUID();

  if (tier === 'bedrock') {
    await streamFromBedrock(requestId, connectionId, req, post);
    return { statusCode: 200, body: 'bedrock done' };
  }

  const ttl = Math.floor(Date.now() / 1000) + 15 * 60; // 15 min - generous vs. cold-start times
  await ddb.send(
    new PutCommand({
      TableName: REQUESTS_TABLE,
      Item: { requestId, connectionId, tier, status: 'queued', createdAt: new Date().toISOString(), ttl },
    }),
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: tier === 'small' ? SMALL_QUEUE_URL : MEDIUM_QUEUE_URL,
      MessageBody: JSON.stringify({
        requestId,
        connectionId,
        apiGatewayEndpoint: endpoint,
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        topP: req.topP,
      }),
    }),
  );

  await post({ type: 'queued', requestId, tier });
  return { statusCode: 200, body: 'queued' };
};

async function streamFromBedrock(
  requestId: string,
  connectionId: string,
  req: InferRequest,
  post: (payload: unknown) => Promise<void>,
) {
  await post({ type: 'queued', requestId, tier: 'bedrock' });

  const controller = new AbortController();
  try {
    const response = await bedrock.send(
      new InvokeModelWithResponseStreamCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          top_p: req.topP,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      }),
      { abortSignal: controller.signal },
    );

    for await (const event of response.body ?? []) {
      if (!event.chunk?.bytes) continue;
      const chunk = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf-8'));

      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        try {
          await post({ type: 'token', requestId, tier: 'bedrock', token: chunk.delta.text });
        } catch (err) {
          if (err instanceof GoneException) {
            controller.abort(); // client is gone - stop paying for further Bedrock output
            return;
          }
          throw err;
        }
      } else if (chunk.type === 'message_stop') {
        await post({ type: 'done', requestId, tier: 'bedrock' });
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    await post({ type: 'error', requestId, error: 'inference failed', detail: (err as Error).message });
  }
}
