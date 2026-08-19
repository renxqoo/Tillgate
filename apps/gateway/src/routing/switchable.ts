/**
 * 换渠道判定（app 纯规则）：chat 与 embeddings 等所有生成路径共用一份词表——
 * 历史上两路由各维护一套错误码集合导致漂移（单个坏渠道让 embeddings 整体不可用）。
 *
 *   换渠道：5xx/网络/超时/死凭据/熔断/限流/空完成/无效响应（渠道或配置问题，别的渠道可能好）
 *   不换：400/404/413 等客户端错误（换渠道也一样失败）
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
  'forbidden',
  'empty_completion',
  'invalid_response',
  'invalid_config',
]);

export function isChannelSwitchable(code: string | undefined): boolean {
  return code != null && CHANNEL_SWITCHABLE_CODES.has(code);
}

/** 死凭据判定（单一真相 = ai 包 classify 的 deadCredential 标志，网关不再按码重判） */
export function isDeadCredentialError(
  error: { deadCredential?: boolean; code?: string } | undefined,
): boolean {
  return error?.deadCredential === true;
}
