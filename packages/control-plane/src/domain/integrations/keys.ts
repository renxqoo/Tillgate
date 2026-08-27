/**
 * 集成键封闭词表与运行常量（单一真相）。
 * DB CHECK（migrations/0086）、admin 契约与 UI 卡片词表与本表逐项相等——契约测试锁定。
 */

/** 集成键（封闭词表；无行 = 未配置。oauth.base 已退回 env） */
export const INTEGRATION_KEYS = [
  'oauth.github',
  'oauth.google',
  'smtp',
  'captcha.turnstile',
  'payment.epay',
  'payment.stripe',
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/** 消费侧整体快照缓存 TTL（ms）：写后跨进程最迟收敛窗口（一致性预算） */
export const INTEGRATION_CACHE_TTL_MS = 60_000;

/** 支付验签密钥轮换双读窗（ms）：96h = Stripe 官方重试期 3 天 + 余量，到期自愈 */
export const PAYMENT_SECRET_ROTATION_WINDOW_MS = 96 * 60 * 60 * 1000;

/** 值长度上限（字节级防滥用；URL/密钥常规远小于此） */
export const INTEGRATION_FIELD_MAX_LENGTH = 1024;

export function isIntegrationKey(value: string): value is IntegrationKey {
  return (INTEGRATION_KEYS as readonly string[]).includes(value);
}
