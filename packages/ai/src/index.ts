/**
 * @tillgate/ai 公共出口（P1 阶段：契约面——类型、错误归一、配置）。
 * createAi 装配壳与传输/协议/管线在 P2-P4 落地后进入本出口（IMPLEMENTATION.md §5）。
 */

// ---- 错误归一（§3.2 单一真相）----
export {
  UpstreamError,
  isUpstreamError,
  isRetryable,
  isDeadCredential,
  KIND_MECHANICS,
} from './errors/kinds';
export type { ErrorKind, ErrorMechanics } from './errors/kinds';

// ---- 配置 ----
export { aiDefaultsSchema, defaultAiDefaults } from './config';
export type { AiDefaults, AiDefaultsInput, AiDeps, AiOptions } from './config';

// ---- 适配器契约（扩展面）----
export type {
  ProtocolAdapter,
  UpstreamRequestPlan,
  ProbeRequest,
  ProtocolTaskKind,
  ProtocolTaskOps,
} from './adapters/protocol-adapter';

// ---- 外部契约类型 ----
export type {
  Ai,
  CallEvents,
  CallOptions,
  ChannelClient,
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  Endpoint,
  GenerationArtifact,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  ParamAdjustment,
  ParamRules,
  ProbeResult,
  Protocol,
  StreamError,
  TerminationReason,
  TextTokenFeatures,
  UrlGuard,
  Usage,
} from './types';

// ---- 装配与传输 ----
export { createAi, SUPPORTED_PROTOCOLS } from './create-ai';

// ---- 厂商档案词表（admin 下拉/control-plane capabilities 单一真相;admin-api P6 接缝）----
export { vendorProfileNames } from './registry/vendor-profiles';
export { assertSafeUrl, assertSafeUrlSync, allowAllUrls } from './transport/http-client';

// ---- 特征计数器（估算充分统计量，单一真相）----
export { extractTextFeatures, TextFeaturesAccumulator } from './usage/features';
export { estimateAudioDurationSeconds } from './usage/media-duration';

// ---- 入站协议翻译（app HTTP 面消费：外部线格式 ↔ 规范 chat 形；§3.6 透传例外 1）----
export {
  completionsRequestToChat,
  chatResponseToCompletions,
  canonicalStreamToCompletionsStream,
} from './protocol/completions-chat';
export {
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
} from './protocol/responses-chat';
export {
  DEFAULT_CLAUDE_MAX_TOKENS,
  claudeRequestToChat,
  chatResponseToClaude,
} from './protocol/claude-chat';
export { canonicalStreamToClaudeStream } from './protocol/claude-stream';
export { geminiRequestToChat, chatResponseToGemini } from './protocol/gemini-chat';
export { canonicalStreamToGeminiStream } from './protocol/gemini-stream';

// ---- 事件契约 ----
export type { AiEvent } from './events';
