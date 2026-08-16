import { timingSafeEqual } from 'node:crypto';

/**
 * 深度健康报告（/health）令牌门（R6/G2，自 worker-application 提取为可测函数）。
 * livez/readyz 不经此门（编排器探针语义，无敏感字段）。
 * 语义：token 未配置 → 一律拒绝（fail-closed）；配置则恒定时间比较。
 */
export function isDeepHealthAuthorized(provided: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
