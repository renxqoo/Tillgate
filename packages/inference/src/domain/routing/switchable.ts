/**
 * 换渠判定（v1 gateway routing/switchable.ts 迁移；词表源换成 v2 ai 的 ErrorKind
 * 封闭词表 + inference 内部拒绝码）。
 *
 *   换渠道：传输/上游服务/凭据/渠道配置问题（别的渠道可能好）；
 *   透传：4xx 客户端错误（换渠道也一样失败——fallback 救不了参数错误）；
 *   换候选：其余（非 4xx 的不可换错误，v1 兜底臂语义保留）。
 */
export type RouteAction = 'switch_channel' | 'next_candidate' | 'respond';

/**
 * 可换渠词表（单一真相）：
 * - ai ErrorKind 子集：传输类 + 上游服务类中「渠道面」错误 + 渠道配置错误；
 *   overloaded（529 族）随 upstream_error 归可换；
 * - inference 内部拒绝码：health.admit 的 circuit_open/dead_credential、
 *   渠道预算 channel_budget_exhausted、渠道维限流 rate_limit_exceeded/rate_limited。
 */
const CHANNEL_SWITCHABLE_CODES: ReadonlySet<string> = new Set([
  // ai ErrorKind（传输/上游服务/渠道配置）
  'network',
  'timeout',
  'upstream_error',
  'overloaded',
  'rate_limited',
  'quota_exhausted',
  'invalid_api_key',
  'insufficient_permissions',
  'empty_completion',
  'invalid_response',
  'invalid_config',
  'unsupported_protocol',
  'task_ops_unavailable',
  // inference 内部拒绝码
  'circuit_open',
  'dead_credential',
  'channel_budget_exhausted',
  'rate_limit_exceeded',
]);

export function isChannelSwitchable(code: string | undefined | null): boolean {
  return code != null && CHANNEL_SWITCHABLE_CODES.has(code);
}

/**
 * 上游失败分派（非流式 / 流式首字节前共用）：
 * 可换 → 换渠道；4xx → 透传终局（上游确定未计费，收尾后原码返回）；
 * 其余 → 换候选模型。
 */
export function routeFailure(error: { kind?: string; status?: number }): RouteAction {
  if (isChannelSwitchable(error.kind)) return 'switch_channel';
  const status = error.status ?? 0;
  if (status >= 400 && status < 500) return 'respond';
  return 'next_candidate';
}

/**
 * 全败终结分类（v1 releaseAndFail 语义）：从未得到上游响应、纯渠道面拒绝
 * （无渠道/预算耗尽/限流/上游 429 归一码）= 渠道面竭尽（no_available_channel）；
 * 其余上游故障 = upstream_failed。
 */
export function isChannelExhausted(code: string | undefined | null): boolean {
  return (
    code == null ||
    code === 'channel_budget_exhausted' ||
    code === 'rate_limit_exceeded' ||
    code === 'rate_limited'
  );
}
