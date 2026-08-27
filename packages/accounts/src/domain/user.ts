/**
 * 用户资料域规则:显示名兜底派生(local/OAuth 两种)。
 * email 规范化见 fields.ts;状态词汇见 status.ts。
 */
import { FIELD_LIMITS } from './fields.js';

/** 本地建号显示名兜底:email 本地部分(@ 前)截 64 */
export function localDisplayNameFallback(email: string): string {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  return local.slice(0, FIELD_LIMITS.displayName) || email.slice(0, FIELD_LIMITS.displayName);
}

/** OAuth 建号显示名兜底:「用户{subject 前 6}」截 64 */
export function oauthDisplayNameFallback(subject: string): string {
  return `用户${subject.slice(0, 6)}`.slice(0, FIELD_LIMITS.displayName);
}

/** 显示名清洗:trim + 截 64(超长截断而非拒绝——兜底派生专用;用户输入走 normalizeName 校验) */
export function clampDisplayName(input: string): string {
  return input.trim().slice(0, FIELD_LIMITS.displayName);
}
