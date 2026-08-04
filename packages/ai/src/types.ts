/**
 * packages/ai 核心类型（设计见 docs/ai-package.md）
 * 本包只做「可靠调用上游并产出结构化事件」，不含任何业务知识。
 */
import type { AiEvent } from './events.js';

/** 渠道描述（由 gateway 注入，apiKey 为解密后的明文，包内不落盘） */
export interface ChannelDesc {
  baseUrl: string;
  apiKey: string;
  /** 一期仅 openai-compatible */
  protocol: Protocol;
}

export type Protocol = 'openai-compatible' | 'anthropic' | 'gemini';

/** 参数抹平规则（透传为基底，规则驱动，见 ai-package.md §7.6） */
export interface ParamRules {
  /** 删除：该模型不支持、传了会 400 的参数（如 reasoning 模型的 temperature） */
  ignore?: string[];
  /** 钳制：超范围会 400 的参数（如 max_tokens ≤ 8192） */
  clamp?: Record<string, { min?: number; max?: number }>;
  /** 改写：参数改名（如 max_tokens ↔ max_completion_tokens） */
  map?: Record<string, { to: string }>;
  /** 未知参数策略，默认 passthrough（透传） */
  unknown?: 'passthrough' | 'drop';
}

/** 单次调用上下文（由 gateway 注入） */
export interface RequestCtx {
  /** 幂等键 */
  requestId: string;
  /** 真实模型名 */
  model: string;
  /** 厂商名（deepseek/glm/...，用于加载 profiles 默认规则） */
  providerName: string;
  /** per-model 参数规则，覆盖 profile 默认 */
  paramRules?: ParamRules;
  /** 同渠道最大重试次数，默认 3 */
  maxRetries?: number;
  /** 总 deadline，默认 240s */
  deadlineMs?: number;
  /** 调用端点：chat（默认）或 embeddings（决定 URL 路径） */
  endpoint?: 'chat' | 'embeddings';
}

/** usage 归一化（缓存计费数据源） */
export interface Usage {
  inputTokens: number;
  /** 缓存命中输入（OpenAI cached_tokens / DeepSeek cache_hit 归一化） */
  cachedInputTokens: number;
  outputTokens: number;
  /** usage 缺失，按字符估算 */
  estimated: boolean;
  /** 原始 usage 保留（排查/审计） */
  raw: unknown;
}

/** 统一错误模型：一次分类同时驱动重试 / 熔断 / 死凭据三种机制 */
export interface UpstreamError extends Error {
  /** undefined = 网络/超时 */
  status?: number;
  /** invalid_api_key / rate_limited / upstream_error / timeout / network / model_not_found ... */
  code: string;
  /** 是否值得重试 */
  retryable: boolean;
  /** 是否计入熔断（5xx/网络/超时 = true；429/4xx/死凭据 = false） */
  circuitTrip: boolean;
  /** 死凭据标记（401/403 + 错误文本特征） */
  deadCredential: boolean;
  /** 可操作建议（进错误信封） */
  suggestion?: string;
  /** 上游响应体（脱敏前，仅日志） */
  rawBody?: string;
}

/** 流式错误帧（从 SSE 中捕获） */
export interface StreamError {
  code: string;
  type?: string;
  detail?: string;
}

/** 非流式结果 */
export type ChatResult =
  | { status: 'success'; usage?: Usage; durationMs: number; body?: unknown }
  | { status: 'empty' | 'error'; error?: UpstreamError; durationMs: number };

/** 流式结果：透传管道 + 事件订阅 */
export interface ChatStreamResult {
  /** 透传管道（含心跳注入与错误帧转换） */
  stream: ReadableStream<Uint8Array>;
  onEvent: (cb: (e: AiEvent) => void) => void;
}

/** 连通性探测结果（admin-api 渠道测试用） */
export interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: UpstreamError;
}

/** 对外 API 形状（create-ai.ts 组装实现，此处定义便于类型集中管理） */
export interface Ai {
  /** 非流式（自动 withRetry：可重试错误 + 空完成重试） */
  chat(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): Promise<ChatResult>;
  /** 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试） */
  chatStream(input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: RequestCtx;
  }): Promise<ChatStreamResult>;
  /** 连通性探测（admin-api 渠道测试用） */
  probe(channel: ChannelDesc): Promise<ProbeResult>;
  /**
   * 全局事件订阅（chat + chatStream 都会通过这条总线发事件）。
   * gateway 在此订阅 attempt_start / param_adjustment / usage / failed / success 等，
   * 用于计量、排障、候选循环驱动。返回取消订阅函数。
   */
  onEvent(cb: (e: AiEvent) => void): () => void;
}
