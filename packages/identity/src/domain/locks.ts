/**
 * advisory lock 键构造器(并发契约,DESIGN §3)。键命名是 identity 业务语义
 * (@tokenlens/db C8 裁决——归本包);锁获取发生在 application 的事务临界区,
 * 适配器只做纯 SQL(铁律 2)。
 */
import type { NormalizedIdentifier } from './identifier.js';

/** 凭据集串行键:挂凭据/解绑/改密/MFA 注册互斥(「登录方式集合」的变更是同键临界区) */
export function credentialSetLockKey(userId: number): string {
  return `identity.user:${userId}`;
}

/** 挑战冷却串行键:同 kind 同目标(标识或用户)的发码互斥 */
export function challengeLockKey(kind: string, targetKey: string): string {
  return `identity.challenge:${kind}:${targetKey}`;
}

export function challengeTargetKey(
  identifier: NormalizedIdentifier | null,
  userId: number | null,
): string {
  return identifier ? `id:${identifier.kind}:${identifier.value}` : `user:${userId}`;
}
