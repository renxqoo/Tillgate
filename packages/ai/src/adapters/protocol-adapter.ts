import type {
  ChannelDesc,
  Endpoint,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  ParamRules,
  UpstreamError,
  Usage,
} from '../types';

/** 参数调整记录（进 param_adjustment 事件，排障可观测） */
export type ParamAdjustment = {
  param: string;
  action: 'ignore' | 'clamp' | 'map';
  from?: unknown;
  to?: unknown;
};

/** 上游寻址计划：协议决定路径与完整请求头（含认证） */
export interface UpstreamRequestPlan {
  /** 相对 baseUrl 的路径（支持 model 进 path 的协议，如 gemini 的 :generateContent） */
  path: string;
  /** 完整请求头（认证 + content-type + 协议特有头，如 anthropic-version） */
  headers: Record<string, string>;
}

/** 连通性探测请求（GET，无副作用） */
export interface ProbeRequest {
  path: string;
  headers: Record<string, string>;
}

/**
 * ProtocolAdapter 契约（扩展点，见 docs/ai-package.md §7.6）
 * 一切协议特定行为都在这层：寻址（路径+认证头）、请求体终改（model 重写 /
 * stream_options 注入 / 格式转换）、usage 提取、错误映射、探测请求。
 * 编排层（create-ai.ts）只做通用编排，不出现任何协议字面量。
 * 新增协议 = 实现本接口 + createAi({ adapters: [...] }) 注册一行。
 */
export interface ProtocolAdapter {
  readonly protocol: string;

  /** 上游寻址：路径与认证头由协议决定（stream 供协议选择流式路径，如 gemini :streamGenerateContent） */
  planRequest(
    channel: ChannelDesc,
    input: { endpoint: Endpoint; model: string; requestId: string; stream: boolean },
  ): UpstreamRequestPlan;

  /**
   * 请求体终态化（发往上游前的最后一次协议特定改写）：
   * model 重写（对外名→真实名）、流式 usage 开关注入、body 格式转换等。
   * 输入为 normalizeRequest 之后的 body（参数抹平已完成）。
   */
  finalizeRequestBody(
    body: Record<string, unknown>,
    input: { endpoint: Endpoint; model: string; stream: boolean },
  ): Record<string, unknown>;

  /** 请求方向：透传为基底，按规则抹平，返回调整记录 */
  normalizeRequest(
    req: unknown,
    rules: ParamRules,
  ): { body: unknown; adjustments: ParamAdjustment[] };

  /** 响应方向：仅提取计量，正文透传 */
  extractUsage(res: unknown): Usage | null;

  /**
   * 响应方向：原生协议响应体 → 规范形（OpenAI 形态）。
   * 仅原生线格式协议需要实现（anthropic/gemini/bedrock）；openai-compatible 不实现
   * （本身就是规范形，字节透传）。create-ai 在非流式路径 readBody 后调用。
   */
  translateResponseBody?(body: unknown): unknown;

  /**
   * 响应方向：原生协议 SSE 字节流 → 规范形 OpenAI SSE 字节流。
   * create-ai 在 peekFirstChunk 之前调用——peek/relay/scanner 全部只面对规范形
   * （管线内部恒为规范形是单一真相，见 docs/ai-package.md）。
   */
  translateUpstreamStream?(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>;

  /**
   * 请求签名钩子（仅签名协议需要，如 bedrock SigV4）：
   * 拿到最终 URL 与序列化 body 后计算认证头（与 plan.headers 合并）。
   * 签名头依赖 body 哈希，无法在 planRequest 静态给出——这是唯一的时序正确位置。
   */
  signRequest?(args: { url: URL; body: string; apiKey: string; amzDate: Date }): Promise<Record<string, string>> | Record<string, string>;

  /** 错误映射（含死凭据文本特征） */
  mapError(status: number | undefined, body: unknown): UpstreamError;

  /** 连通性探测请求（依次尝试，任一 <400 即通；含协议特有认证头） */
  probeRequests(channel: ChannelDesc): ProbeRequest[];

  /**
   * 异步生成任务操作面（任务型协议可选实现，如 minimax）：
   * 提交/执行响应解析 + 任务状态查询寻址与解析 + 产物取回。
   * 全部 MiniMax 等协议知识收口在此——编排层（create-ai）与调用方
   * （gateway 提交 / worker 轮询）只面对归一形。
   */
  tasks?: ProtocolTaskOps;
}

/** 任务型协议的任务操作面（寻址复用 ProbeRequest 形：GET + headers） */
export interface ProtocolTaskOps {
  /** 提交（video）/执行（music 同步完成）响应解析：base_resp 错误信封 → error */
  parseResponse(endpoint: 'video' | 'music', body: unknown): GenerationParsedResponse;
  /** 任务状态查询寻址（GET，taskId 进 query） */
  planTaskQuery(channel: ChannelDesc, taskId: string): ProbeRequest;
  /** 状态响应解析（协议状态枚举 → 归一三态） */
  parseTaskStatus(body: unknown): GenerationTaskProbeResult;
  /** 产物取回寻址（succeeded 时换取下载 URL） */
  planFileRetrieve(channel: ChannelDesc, fileId: string): ProbeRequest;
  /** 产物取回响应解析 */
  parseFileRetrieve(body: unknown): GenerationFileProbeResult;
}
