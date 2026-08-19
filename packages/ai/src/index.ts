export { createAi, SUPPORTED_PROTOCOLS } from './create-ai';
// SSRF 硬门原语（AI 上游 fetch 与 webhook 投递共用——DNS 逐地址判定防 rebinding）
export { assertSafeUrl, assertSafeUrlSync } from './transport/http-client';
export { createRestTaskOps, type RestTaskKitConfig } from './adapters/task-kit';
export {
  createGenerationTaskAdapter,
  type AiTaskAdapterDeps,
  type TaskChannelDesc,
  type TaskPortErrorShape,
} from './generation/task-adapter';
export { ServerDrainAbort, asServerDrainAbort } from './errors/server-drain';
// 契约分粒度扩展入口 + 厂商档案（admin 校验/下拉引用 vendorProfileNames 单一真相）
export { defineAdapter, type DefineAdapterInput } from './registry/define-adapter';
export {
  VENDOR_PROFILES,
  mergeParamRules,
  resolveVendorProfile,
  vendorProfileNames,
  type VendorProfile,
} from './registry/vendor-profiles';
export { MemoryKvStorage } from './internal/memory-storage';
export { defaultAiConfig } from './config';
export type {
  AiConfig,
  AiConfigInput,
  AiDeps,
  AiOptions,
  BreakerState,
  BreakerStorage,
  DeadCredentialState,
  DeadCredentialStorage,
} from './config';
export type { AiEvent } from './events';
export { DeadCredentialTracker } from './dead-credential/tracker';
export type { DeadCredentialConfig } from './dead-credential/tracker';
export {
  estimateInputTokens,
  estimateOutputTokens,
  estimateTextTokens,
  estimateUsage,
  extractTextFeatures,
} from './usage/token-estimate';
export type { EstimateOptions, TextTokenFeatures } from './usage/token-estimate';
export { DEFAULT_TOKEN_ESTIMATE_CALIBRATION, resolveCalibration } from './usage/calibration';
export type {
  ProviderCalibration,
  ResolvedCalibration,
  TextTokenWeights,
  TokenEstimateCalibration,
} from './usage/calibration';
export { OpenAICompatibleAdapter } from './adapters/openai-compatible';
export { AnthropicAdapter, ANTHROPIC_VERSION } from './adapters/anthropic';
export { GeminiAdapter } from './adapters/gemini';
export { AzureOpenAIAdapter, AZURE_API_VERSION } from './adapters/azure-openai';
export { AwsBedrockAdapter, signAwsRequest, parseAwsCredentials, parseEventstreamFrames, eventstreamToClaudeSse } from './adapters/aws-bedrock';
export { VertexAiAdapter } from './adapters/vertex-ai';
export * from './protocol/claude-chat';
export * from './protocol/gemini-chat';
export * from './protocol/responses-chat';
export * from './protocol/completions-chat';
export { estimateAudioDurationSeconds } from './usage/media-duration';
export type {
  Addressing,
  BodyFinalizer,
  ErrorMapper,
  ParamAdjustment,
  ProbeRequest,
  ProtocolAdapter,
  ProtocolTaskOps,
  UpstreamRequestPlan,
  UsageExtractor,
  WireCodec,
} from './adapters/protocol-adapter';
export type {
  Ai,
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  Endpoint,
  GenerationArtifact,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  ParamRules,
  ProbeResult,
  Protocol,
  RequestCtx,
  StreamError,
  UpstreamError,
  Usage,
} from './types';
