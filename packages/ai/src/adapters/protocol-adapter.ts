import type { ChannelDesc, Endpoint, ParamRules, UpstreamError, Usage } from '../types';

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

  /** 上游寻址：路径与认证头由协议决定 */
  planRequest(
    channel: ChannelDesc,
    input: { endpoint: Endpoint; model: string; requestId: string },
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

  /** 错误映射（含死凭据文本特征） */
  mapError(status: number | undefined, body: unknown): UpstreamError;

  /** 连通性探测请求（依次尝试，任一 <400 即通；含协议特有认证头） */
  probeRequests(channel: ChannelDesc): ProbeRequest[];
}
