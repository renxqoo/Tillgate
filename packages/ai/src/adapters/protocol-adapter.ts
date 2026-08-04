import type { ParamRules, UpstreamError, Usage } from '../types.js'

/** 参数调整记录（进 param_adjustment 事件，排障可观测） */
export type ParamAdjustment = {
  param: string
  action: 'ignore' | 'clamp' | 'map'
  from?: unknown
  to?: unknown
}

/**
 * ProtocolAdapter 契约（扩展点，见 docs/ai-package.md §7.6）
 * 一期实现：OpenAICompatibleAdapter（透传 + 规则抹平）
 * 二期扩展：AnthropicAdapter / GeminiAdapter（格式转换发生在这层）
 */
export interface ProtocolAdapter {
  readonly protocol: string

  /** 请求方向：透传为基底，按规则抹平，返回调整记录 */
  normalizeRequest(
    req: unknown,
    rules: ParamRules,
  ): { body: unknown; adjustments: ParamAdjustment[] }

  /** 响应方向：仅提取计量，正文透传 */
  extractUsage(res: unknown): Usage | null

  /** 错误映射（含死凭据文本特征） */
  mapError(status: number | undefined, body: unknown): UpstreamError

  /** 连通性探测路径（优先 /v1/models，回退最小补全） */
  probePaths(): string[]
}
