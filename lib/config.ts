export interface TierConfig {
  /** Name used in resource ids / tags */
  name: string;
  /** HuggingFace model id (or pre-baked path in the container image) */
  modelId: string;
  /** EC2 GPU instance type backing this tier's capacity provider */
  instanceType: string;
  /** Max prompt length (chars) this tier is offered as a candidate for */
  maxPromptChars: number;
  /** Max requested output tokens this tier accepts before deferring to the next tier */
  maxTokensCeiling: number;
  min: number;
  max: number;
  /** Target in-flight SQS messages per task, used for queue-depth scaling */
  messagesPerTask: number;
}

export const SMALL_TIER: TierConfig = {
  name: 'small',
  modelId: 'google/gemma-3-270m-it',
  instanceType: 'g6.xlarge', // 1x NVIDIA L4, 24GB VRAM - plenty for a 270M model
  maxPromptChars: 500,
  maxTokensCeiling: 512,
  min: 0,
  max: 4,
  messagesPerTask: 20,
};

export const MEDIUM_TIER: TierConfig = {
  name: 'medium',
  modelId: 'google/gemma-3-4b-it',
  instanceType: 'g6.xlarge', // same single-GPU instance still fits a 4B model comfortably
  maxPromptChars: 2000,
  maxTokensCeiling: 2048,
  min: 0,
  max: 6,
  messagesPerTask: 10,
};

// Claude Sonnet 4.5 on Bedrock only supports INFERENCE_PROFILE invocation
// (confirmed against the account: invoking the bare foundation-model id is
// rejected with "on-demand throughput isn't supported"), so the id actually
// passed to InvokeModelWithResponseStream must be the inference profile id.
export const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
// The underlying foundation model + regions that profile fans out to
// (`aws bedrock get-inference-profile`) - IAM needs InvokeModel* on both
// the profile ARN and the foundation model ARN in every region it can
// route to.
export const BEDROCK_FOUNDATION_MODEL_ID = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
export const BEDROCK_MODEL_ROUTABLE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

// Amazon Nova Micro acts as the semantic router: cheap and fast enough to
// call on (almost) every request, deciding small/medium/large based on task
// complexity rather than raw prompt length. A char/token-length heuristic
// remains as a fallback if the classifier call fails.
export const CLASSIFIER_MODEL_ID = 'amazon.nova-micro-v1:0';
