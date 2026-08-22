/**
 * packages/ai 外部契约类型（v2 平参数 API，见 IMPLEMENTATION.md §1）。
 * 本包只做「可靠调用上游并产出结构化事件」，不含任何业务知识。
 */
import type { AiEvent } from './events';
import type { ErrorKind, UpstreamError } from './errors/kinds';

// ─────────────────────────── 渠道与端点 ───────────────────────────

/** 渠道描述（纯数据；apiKey 为解密后明文，包内不落盘） */
export interface ChannelDesc {
  baseUrl: string;
  apiKey: string;
  /**
   * 协议标识 = 适配器注册表键；合法值由 createAi 注册表决定（词表单一真相
   * SUPPORTED_PROTOCOLS），未注册协议显式报错（invalid_config），不静默回退。
   */
  protocol: string;
  /** 厂商档案引用（可选）：协议族的参数怪癖预设键（词表见 registry/vendor-profiles） */
  vendor?: string;
}

/**
 * 端点类型词表（adapter 寻址单一真相）。
 * 文本族 chat；向量族 embeddings；模态族 images/images_edits/audio_*；任务族 video/music。
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

/** 语义别名：协议标识（string；合法值由适配器注册表决定） */
export type Protocol = string;

// ─────────────────────────── 参数抹平 ───────────────────────────

/** 参数抹平规则（透传为基底，规则驱动；规则数据从 control-plane 注入，包内零默认） */
export interface ParamRules {
  /** 删除：该模型不支持、传了会 400 的参数 */
  ignore?: string[];
  /** 钳制：超范围会 400 的参数 */
  clamp?: Record<string, { min?: number; max?: number }>;
  /** 改写：参数改名 */
  map?: Record<string, { to: string }>;
  /** 未知参数策略，默认 passthrough（wire 保真） */
  unknown?: 'passthrough' | 'drop';
}

/** 参数调整记录（进 param_adjustment 事件，审计留痕） */
export type ParamAdjustment = {
  param: string;
  action: 'ignore' | 'clamp' | 'map';
  from?: unknown;
  to?: unknown;
};

// ─────────────────────────── 计量 ───────────────────────────

/**
 * 估算特征四计数器（token-estimate 启发式层的充分统计量，单一真相）：
 * wordSegments 依赖相邻字符状态机——「字符数」无法还原「词段数」，不可简化为三分类。
 * scanner 按片段统计后累加（求和可交换，与整段统计等价）。
 */
export interface TextTokenFeatures {
  /** CJK 字符数（逐字计） */
  cjkChars: number;
  /** 拉丁连续词段数（"hello world" = 2） */
  wordSegments: number;
  /** 数字段数 */
  numberSegments: number;
  /** 其余符号数 */
  symbolCount: number;
}

/** usage 归一化（缓存计费数据源；方言矩阵见 usage/normalize） */
export interface Usage {
  inputTokens: number;
  /** 缓存命中输入（OpenAI cached_tokens / DeepSeek cache_hit 归一） */
  cachedInputTokens: number;
  /** 缓存写入输入（Anthropic cache_creation 归一；仅事件/日志可见） */
  cacheWriteTokens?: number;
  outputTokens: number;
  /** usage 缺失，按特征估算 */
  estimated: boolean;
  /** 单位计量（按次/张/秒/字符计费端点；token 端点缺省 0） */
  units?: number;
  /** 原始 usage 保留（排障/审计） */
  raw: unknown;
}

// ─────────────────────────── 流终止 ───────────────────────────

/** 流终止原因（单一真相；events 与 relay 共同引用，禁止手抄） */
export type TerminationReason =
  | 'client_disconnect'
  | 'request_cancelled'
  | 'server_draining'
  | 'inactivity'
  | 'upstream_error'
  | 'upstream_disconnected'
  | 'upstream_truncated';

/** 流式错误帧（从 SSE 中捕获；wire 层形状） */
export interface StreamError {
  code: string;
  type?: string;
  detail?: string;
}

// ─────────────────────────── 调用选项与结果 ───────────────────────────

/** 第三参（全可选、平铺——网关传全量，脚本用户零配置） */
export interface CallOptions {
  /** 幂等/关联键：事件流的 join key（计费归属）。缺省 randomUUID */
  requestId?: string;
  /** 覆盖 request.model 并回写 body/form（网关对外名→真实名在此完成） */
  model?: string;
  /** 调用端点，缺省 'chat'（embed 等用 ChannelClient 同名方法） */
  endpoint?: Endpoint;
  /** 调用方取消：客户端断开、总 deadline 或服务 drain */
  signal?: AbortSignal;
  /** per-model 参数规则（策略注入，control-plane 数据） */
  paramRules?: ParamRules;
  /** 厂商名（校准/日志标识；网关从目录注入） */
  providerName?: string;
  /** 同渠道最大尝试次数（缺省 defaults.retry.maxAttempts） */
  maxRetries?: number;
  /** 本次调用总预算（缺省 defaults.retry.deadlineMs） */
  deadlineMs?: number;
}

/** 非流式结果（判别联合；rawBody 为二进制响应——audio_speech 等模态端点） */
export type ChatResult =
  | {
      ok: true;
      usage?: Usage;
      durationMs: number;
      body?: unknown;
      /** 二进制响应体（上游 content-type 非 JSON 时原样字节） */
      rawBody?: Uint8Array;
      /** 二进制响应的 content-type（透传给客户端） */
      rawContentType?: string;
    }
  | { ok: false; error: UpstreamError; durationMs: number; /** 空完成重试耗尽 */ empty?: boolean };

/** per-call 事件订阅面（终态缓冲 + 晚订阅重放） */
export interface CallEvents {
  subscribe(cb: (e: AiEvent) => void): void;
}

/** 流式结果：数据面与观察面在返回值分家 */
export interface ChatStreamResult {
  /** 透传管道（心跳注入与错误帧转换在 transport/relay-stream） */
  stream: ReadableStream<Uint8Array>;
  /** 观察面（per-call） */
  events: CallEvents;
}

/** 连通性探测结果（admin 控制面渠道测试用） */
export interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: UpstreamError;
}

// ─────────────────────────── 任务族 ───────────────────────────

/** 生成产物归一形（厂商/类型无关；形状知识只在 adapter 产出与路由呈现） */
export interface GenerationArtifact {
  url?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  mimeType?: string;
}

/** 任务型端点响应归一解析 */
export type GenerationParsedResponse =
  | { kind: 'task_submitted'; taskId: string }
  | { kind: 'task_completed'; artifact: GenerationArtifact }
  | { kind: 'error'; error: UpstreamError };

/** 任务状态查询结果 */
export type GenerationTaskProbeResult =
  | {
      ok: true;
      status: 'running' | 'succeeded' | 'failed';
      fileId?: string;
      artifact?: GenerationArtifact;
      reason?: string;
    }
  | { ok: false; error: UpstreamError };

/** 产物取回结果 */
export type GenerationFileProbeResult =
  | { ok: true; downloadUrl: string }
  | { ok: false; error: UpstreamError };

// ─────────────────────────── SSRF 策略注入 ───────────────────────────

/**
 * URL 守卫（SSRF 策略注入点）：抛错 = 拒绝。机制固定在包内（卡在网络出口），
 * 策略（受信名单是业务数据）由装配方注入——组合 `assertSafeUrl(u, { allowedHosts })`。
 */
export type UrlGuard = (url: string) => Promise<void>;

// ─────────────────────────── 对外 API 形状 ───────────────────────────

export { UpstreamError };
export type { ErrorKind };

/** 渠道绑定客户端（SDK 手感糖：闭包固定 channel，委托同一内核） */
export interface ChannelClient {
  chat(request: unknown, opts?: CallOptions): Promise<ChatResult>;
  stream(request: unknown, opts?: CallOptions): Promise<ChatStreamResult>;
  embed(request: unknown, opts?: CallOptions): Promise<ChatResult>;
  probe(): Promise<ProbeResult>;
}

/** 对外 API（create-ai.ts 组装实现；类型集中于此） */
export interface Ai {
  /** 非流式（自动 withRetry：可重试错误 + 空完成独立预算） */
  chat(channel: ChannelDesc, request: unknown, opts?: CallOptions): Promise<ChatResult>;
  /** 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试） */
  chatStream(channel: ChannelDesc, request: unknown, opts?: CallOptions): Promise<ChatStreamResult>;
  /** 渠道绑定糖（脚本/外部消费者手感） */
  use(channel: ChannelDesc): ChannelClient;
  /** 连通性探测 */
  probe(channel: ChannelDesc): Promise<ProbeResult>;
  /**
   * 全局事件订阅（chat + chatStream 共用总线）。计费/审计/trace/渠道健康四类
   * 订阅者挂装配处，只挂一次；返回退订函数。分发为快照迭代（退订竞态安全）。
   */
  subscribe(observer: (e: AiEvent) => void): () => void;
  /** 协议词表单一真相（control-plane 校验引用） */
  readonly SUPPORTED_PROTOCOLS: readonly string[];
  /** 异步生成任务操作面（任务型协议提供；未注册协议显式报错） */
  readonly tasks: {
    parse(channel: ChannelDesc, kind: 'video' | 'music', body: unknown): GenerationParsedResponse;
    query(channel: ChannelDesc, taskId: string): Promise<GenerationTaskProbeResult>;
    file(channel: ChannelDesc, fileId: string): Promise<GenerationFileProbeResult>;
  };
}
