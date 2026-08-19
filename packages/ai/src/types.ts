/**
 * packages/ai 核心类型（设计见 docs/ai-package.md）
 * 本包只做「可靠调用上游并产出结构化事件」，不含任何业务知识。
 */
import type { AiEvent } from './events';

/** 渠道描述（由 gateway 注入，apiKey 为解密后的明文，包内不落盘） */
export interface ChannelDesc {
  baseUrl: string;
  apiKey: string;
  /**
   * 协议标识 = 适配器注册表的键。合法值由 createAi 的注册表决定
   * （未注册协议显式报错 invalid_config，不静默回退）——词表单一真相见 SUPPORTED_PROTOCOLS。
   */
  protocol: string;
  /**
   * 厂商档案引用（providers.vendor，可选）：openai-compatible 协议族的参数怪癖
   * 预设键（词表单一真相见 registry/vendor-profiles.ts 的 VENDOR_PROFILES）。
   * 在 prepare 处编译进 ParamRules（与 per-model 规则合并，model 侧优先）。
   */
  vendor?: string;
}

/** 调用端点（决定 adapter 选择的上游路径） */
/**
 * 端点类型词表（管线/adapter 寻址单一真相）。
 * 文本族：chat（chat/completions、completions、responses、claude messages、gemini 原生经 codec 归一）
 * 向量族：embeddings
 * 模态族：images / images_edits（生成/编辑）、audio_speech（TTS，二进制出）、
 *         audio_transcription / audio_translation（STT，multipart 入）、rerank、moderations
 * 任务族：video / music（异步生成任务——提交即返回，完成态由 worker 轮询驱动；
 *         仅支持提供 tasks 操作面的协议，如 minimax）
 */
export type Endpoint =
  | 'chat'
  | 'embeddings'
  | 'images'
  | 'images_edits'
  | 'audio_speech'
  | 'audio_transcription'
  | 'audio_translation'
  | 'rerank'
  | 'moderations'
  | 'video'
  | 'music';

/** 语义别名：协议标识（string；合法值由适配器注册表决定，见 ChannelDesc.protocol） */
export type Protocol = string;

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
  /** 厂商名（deepseek/glm/...，用于日志/排障标识） */
  providerName: string;
  /** per-model 参数规则，覆盖 profile 默认 */
  paramRules?: ParamRules;
  /** 同渠道最大重试次数，默认 3 */
  maxRetries?: number;
  /** 本次调用可使用的剩余预算；Gateway 每个 fallback 前重新计算，绝不重置总预算。 */
  deadlineMs?: number;
  /** 调用方取消：客户端断开、请求总 deadline 或服务 drain。 */
  signal?: AbortSignal;
  /**
   * 调用端点（必填——adapter 据此决定上游路径）。
   * 历史教训：曾经可选并兜底 'chat'，导致 embeddings/模态族生产路径全部
   * 寻址到 /v1/chat/completions（mock 上游不校验路径，测试拦不住）。
   * 端点知识在路由边界已知，必须显式传递，不留隐式默认。
   */
  endpoint: Endpoint;
}

/** usage 归一化（缓存计费数据源） */
export interface Usage {
  inputTokens: number;
  /** 缓存命中输入（OpenAI cached_tokens / DeepSeek cache_hit 归一化） */
  cachedInputTokens: number;
  outputTokens: number;
  /** usage 缺失，按字符估算 */
  estimated: boolean;
  /**
   * 单位计量（按次/张/秒/字符计费的端点；token 计费端点缺省 0）。
   * 与 model_mappings.pricing_unit 配对——images 张数、audio 秒数/字符数等。
   */
  units?: number;
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

/** 非流式结果（rawBody：二进制响应——audio_speech 等模态端点的音频字节） */
export type ChatResult =
  | {
      status: 'success';
      usage?: Usage;
      durationMs: number;
      body?: unknown;
      /** 二进制响应体（上游 content-type 非 JSON 时原样字节） */
      rawBody?: Uint8Array;
      /** 二进制响应的 content-type（透传给客户端） */
      rawContentType?: string;
    }
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

  // ---- 异步生成任务（任务型协议适配器提供；未提供时调用方按不支持处理）----

  /** 任务型端点提交/执行响应解析（video 提交→taskId；music 同步完成→产物 URL） */
  parseGenerationResponse?(input: {
    channel: ChannelDesc;
    endpoint: 'video' | 'music';
    body: unknown;
  }): GenerationParsedResponse;
  /** 上游任务状态查询（video 轮询用；瞬时网络错误返回 error，调用方下轮再查） */
  queryGenerationTask?(input: {
    channel: ChannelDesc;
    taskId: string;
  }): Promise<GenerationTaskProbeResult>;
  /** 上游产物取回（succeeded 后换取下载 URL） */
  retrieveGenerationFile?(input: {
    channel: ChannelDesc;
    fileId: string;
  }): Promise<GenerationFileProbeResult>;
}

/**
 * 生成产物归一形（厂商/类型无关）：适配器产出、poller 原样落
 * generation_tasks.result、路由层映射对外字段（video_url/audio_url/尺寸）。
 * 类型与厂商的形状知识只存在于适配器（产出）与路由（呈现），执行层零感知。
 */
export interface GenerationArtifact {
  /** 产物下载地址（24h 时效由上游定义；取不到时由路由呈现 null） */
  url?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  mimeType?: string;
}

/** 任务型端点响应的归一解析（协议知识收口在适配器） */
export type GenerationParsedResponse =
  | { kind: 'task_submitted'; taskId: string }
  | { kind: 'task_completed'; artifact: GenerationArtifact }
  | { kind: 'error'; error: UpstreamError };

/** 任务状态查询结果 */
export type GenerationTaskProbeResult =
  | {
      ok: true;
      status: 'running' | 'succeeded' | 'failed';
      /** succeeded 时上游产物句柄（协议各异：MiniMax=file_id；url 直返型协议可带 artifact） */
      fileId?: string;
      /** succeeded 时产物归一形（url 需经 files/retrieve 换取的协议由编排层补齐） */
      artifact?: GenerationArtifact;
      /** failed 时原因 */
      reason?: string;
    }
  | { ok: false; error: UpstreamError };

/** 产物取回结果 */
export type GenerationFileProbeResult =
  | { ok: true; downloadUrl: string }
  | { ok: false; error: UpstreamError };
