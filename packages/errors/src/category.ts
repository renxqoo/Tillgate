/**
 * category 闭集——业务错误的唯一处理契约（ADR-0001 D4、DESIGN §3.2）：
 * catch 站点与协议出口只对 category（及 nature）分派，不对错误类、不对层、不对 status 分派。
 * 闭集为编译期 union + 测试双锁；增删走 ADR。
 */

/** category 闭集（七项；quota_exhausted 为 v2 增补——v1 注册表 8×402 资金族无处安放的审计证据） */
export const ERROR_CATEGORIES = [
  'invalid_input', // 调用方数据问题 → 4xx，不重试
  'not_found', // 目标不存在 → 404
  'conflict', // 状态/唯一性冲突 → 409，修正后可重试
  'forbidden', // 资格/权限/状态不允许 → 401/403
  'quota_exhausted', // 资金/额度维度不允许 → 402；需充值/换渠道/换计划
  'rate_limited', // 限流 → 429，退避后可重试
  'unavailable', // 依赖不可用/自我保护拒流 → 5xx，可重试 + 告警
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** category 处理语义默认（单点真相；禁止逐例覆盖——某码需要不同语义即 category 选错，ADR-0001 D5） */
export interface CategoryDefault {
  /** 机械重试是否值得（rate_limited 退避后可；conflict 须修正请求后另发起） */
  readonly retryable: boolean;
  /** 默认告警等级是否需要运维关注（unavailable 需要；业务拒绝不需要） */
  readonly alert: boolean;
}

export const CATEGORY_DEFAULTS: Readonly<Record<ErrorCategory, CategoryDefault>> = Object.freeze({
  invalid_input: { retryable: false, alert: false },
  not_found: { retryable: false, alert: false },
  conflict: { retryable: false, alert: false },
  forbidden: { retryable: false, alert: false },
  quota_exhausted: { retryable: false, alert: false },
  rate_limited: { retryable: true, alert: false },
  unavailable: { retryable: true, alert: true },
});

/** 运行时判别（JSON/边界数据进来的 category 字符串校验） */
export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && (ERROR_CATEGORIES as readonly string[]).includes(value);
}
