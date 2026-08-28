/**
 * @tillgate/inference 公共出口：facade、输入/结果契约、错误目录、端口类型与
 * 装配适配器工厂（根入口不导出内部实现细节；ai 类型消费方自 @tillgate/ai 引用）。
 */
export { createInference } from './inference';
export type { ChatInput, Inference, InferenceEnv } from './inference';
export type { ChatDelivered } from './application/chat';
export type { StreamDelivered } from './application/stream';
export type { PassthroughDelivered, ChannelAdmission } from './application/failover';
export type { GenerationSubmitInput, GenerationSubmitOutcome } from './application/generation';
export { createGenerationPollUseCase } from './application/generation-poll';
export type {
  GenerationPollConfig,
  GenerationPollResult,
  GenerationPollDeps,
} from './application/generation-poll';

// ---- 错误目录 ----
export { InferenceErrors } from './domain/errors';

// ---- 配置（装配可覆写缺省）----
export { inferenceDefaultsSchema, defaultInferenceDefaults } from './config';
export type { InferenceDefaults, InferenceDefaultsInput } from './config';

// ---- 端口契约（装配注入实现）----
export type { CatalogPort, CatalogPricingContext } from './ports/catalog';
export type { BillingPort, BillingSignal } from './ports/billing';
export type { TracePort, SpanHandle, TraceAttributes, TraceAttributeValue } from './ports/trace';
export type {
  UpstreamPort,
  UpstreamCallRequest,
  UpstreamStreamEvent,
  UpstreamStreamResult,
  UpstreamTaskSubmitResult,
  UpstreamTaskExecuteResult,
} from './ports/upstream';
export type { HealthStore, Versioned } from './ports/state';
export type {
  GenerationTaskStore,
  GenerationTaskRecord,
  GenerationTaskView,
  GenerationTaskActiveRow,
  GenerationTaskAdminRow,
  GenerationTaskAdminListInput,
  GenerationTaskStatus,
} from './ports/generation';
export { GENERATION_TASK_STATUSES } from './ports/generation';

// ---- 目录/收据契约（端口实现方与 billing 消费方引用）----
export type {
  ModelMappingSnapshot,
  ChannelCandidate,
  QuoteCandidate,
  RequestAuth,
  PricingUnit,
} from './domain/model/types';
export { buildCandidateChain } from './domain/model/candidates';
export { conservativeInputTokenUpperBound } from './domain/model/output-cap';
export type {
  UsageReceipt,
  ReceiptParams,
  ReceiptUsage,
  TrustedUsage,
  EstimatedUsage,
} from './domain/usage/receipt';
export {
  ESTIMATE_ATTRIBUTIONS,
  USER_SIDE_CANCELS,
  streamEstimateAttribution,
  isAttributedEstimate,
} from './domain/usage/attribution';
export type { EstimateAttribution, UserSideCancel } from './domain/usage/attribution';
export { GENERATION_KINDS, GENERATION_TASK_KINDS, isGenerationTaskKind } from './domain/generation';
export type { GenerationTaskKind, GenerationKindDescriptor } from './domain/generation';

// ---- 渠道健康（AiEvent 订阅者）----
export { createChannelHealth, channelHealthKey } from './health/channel-health';
export type { ChannelHealth, HealthAdmission } from './health/channel-health';
export type { BreakerConfig, BreakerState } from './health/breaker';
export type { DeadCredentialConfig, DeadCredentialState } from './health/dead-credential';

// ---- 装配适配器工厂（生产/开发形态选择；./composition 语义收进根出口的工厂面）----
export { createUpstreamAi } from './adapters/upstream-ai';
export { createRedisHealthStore } from './adapters/state-redis';
export { createMemoryHealthStore } from './adapters/state-memory';
export { createMemoryGenerationTaskStore } from './adapters/task-memory';
export { createPostgresGenerationTaskStore } from './adapters/generation-pg';

// ---- 入站协议翻译转出口（「apps 运行时代码不直接 import ai」——
//      外部线格式 ↔ 规范形的纯翻译函数经本包转发，app HTTP 面单一引用面） ----
export {
  completionsRequestToChat,
  chatResponseToCompletions,
  canonicalStreamToCompletionsStream,
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
  claudeRequestToChat,
  chatResponseToClaude,
  canonicalStreamToClaudeStream,
  geminiRequestToChat,
  chatResponseToGemini,
  canonicalStreamToGeminiStream,
  estimateAudioDurationSeconds,
} from '@tillgate/ai';
export type { Endpoint } from '@tillgate/ai';
