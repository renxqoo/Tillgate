/**
 * 换渠判定（词表源 = ai 的 ErrorKind
 * 封闭词表 + inference 内部拒绝码）。
 *
 *   换渠道：传输/上游服务/凭据/渠道配置问题（别的渠道可能好）；
 *   透传：4xx 客户端错误（换渠道也一样失败——fallback 救不了参数错误）；
 *   换候选：其余（非 4xx 的不可换错误）。
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

export function isChannelSwitchable(code?: string | null): boolean {
  return code != null && CHANNEL_SWITCHABLE_CODES.has(code);
}

/**
 * 请求维门拒绝码（模型死记忆的豁免来源）：这些拒绝取决于「本请求」的属性
 * （敞口估算 / 预占估算）或网关侧可配软限，同一渠道对大请求拒绝、对小请求
 * 放行——不是模型不可用的事实，计入死记忆会让个别用户的请求形态把模型
 * 判死（误伤所有用户）：
 *   - channel_budget_exhausted：预算硬闸按「本请求敞口估算 vs 渠道剩余」拒绝；
 *   - rate_limit_exceeded：app 渠道准入钩子（gateway RPM 滑窗 + TPM 预占，
 *     TPM 预占按请求估算 token，同属请求维）。
 * 反映渠道/模型真实健康的失败（上游错误 kind、熔断、死凭据、上游 429/quota
 * 惩罚）不在词表内，仍计入死记忆。
 */
const REQUEST_SCOPED_REJECTIONS: ReadonlySet<string> = new Set([
  'channel_budget_exhausted',
  'rate_limit_exceeded',
]);

export function isRequestScopedRejection(code?: string | null): boolean {
  return code != null && REQUEST_SCOPED_REJECTIONS.has(code);
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
 * 全败终结分类：从未得到上游响应、纯渠道面拒绝
 * （无渠道/预算耗尽/限流/上游 429 归一码，以及 health.admit 的熔断/死凭据拒绝）
 * = 渠道面竭尽（no_available_channel，503）；其余上游故障 = upstream_failed（502）。
 *
 * 注：circuit_open/dead_credential 归入渠道面竭尽——admission 拒绝是网关侧保护
 * 动作（未发出上游请求），全渠道熔断/死凭据竭尽不得误归上游故障 502。
 */
export function isChannelExhausted(code?: string | null): boolean {
  return (
    code == null ||
    code === 'channel_budget_exhausted' ||
    code === 'rate_limit_exceeded' ||
    code === 'rate_limited' ||
    // 上游欠费（402/quota）：渠道进货额度外的渠道面竭尽——单渠道欠费全败时
    // 503「无可用渠道」语义准确（运营该充值/换供应商），502 会误导向上游故障排障
    code === 'quota_exhausted' ||
    code === 'circuit_open' ||
    code === 'dead_credential' ||
    // 全候选被死记忆跳过（模型维不可用）也归渠道面竭尽——503 而非误报上游故障 502
    code === 'no_available_channel'
  );
}
