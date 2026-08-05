/**
 * 渠道切换判定（候选循环共用，requirements 5.9）。
 *
 * chat-completions 与 embeddings 两条路由的「换渠道 vs 直接返回客户端」判定必须一致——
 * 历史上两路由各自维护错误码集合导致漂移（embeddings 漏掉 dead_credential / forbidden /
 * quota_exhausted / empty_completion / invalid_response），单个坏渠道让 embeddings 整体不可用。
 * 抽到此处共享，杜绝再次不一致。
 *
 * 判定口径：
 *   换渠道：5xx/网络/超时/死凭据/熔断/限流/空完成/无效响应（渠道或配置问题，别的渠道可能好）
 *   不换：400/404/413 等 4xx 客户端错误（换渠道也一样失败）
 */
const CHANNEL_SWITCHABLE_CODES = new Set([
  'upstream_error',
  'network',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'circuit_open',
  'dead_credential',
  'invalid_api_key', // 401 死凭据：此渠道 key 坏了，别的渠道可能好
  'forbidden', // 403：同上
  'empty_completion',
  'invalid_response',
]);

export function isChannelSwitchable(code: string | undefined): boolean {
  return code ? CHANNEL_SWITCHABLE_CODES.has(code) : false;
}
