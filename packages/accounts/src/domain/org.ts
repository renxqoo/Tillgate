/**
 * 组织/邀请域规则:待接受上限公式、邀请 token 形态、成员角色词汇。
 * 席位不变量的权威编排在 accept 事务(application);此处是纯计算。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 成员角色词汇(org_members.role DDL 契约) */
export const MEMBER_ROLES = { OWNER: 'owner', MEMBER: 'member' } as const;

export type MemberRole = (typeof MEMBER_ROLES)[keyof typeof MEMBER_ROLES];

export interface InvitationPendingPolicy {
  /** 待接受上限 = min(max(剩余席位, 1) × factor, cap)(缺省 factor=2, cap=20) */
  readonly factor: number;
  readonly cap: number;
}

/**
 * 待接受邀请上限 = min(max(剩余,1)×factor, cap),factor/cap 由 policy 显式注入。
 * 允许 pending 总数超过剩余席位——防刷邀请行的有意设计,与席位闸并存。
 */
export function pendingInvitationLimit(
  remainingSeats: number,
  policy: InvitationPendingPolicy,
): number {
  const base = Math.max(remainingSeats, 1);
  return Math.min(base * policy.factor, policy.cap);
}

/** 生成邀请 token:32 hex(uuid 去杠);只在创建响应下发一次 */
export function generateInvitationToken(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * 邀请 token 落库形态:sha256 hex(64 字符,恰合 varchar(64))。明文只在创建响应
 * 下发一次——只读库泄露拿不到可接受凭证(对照 pwdreset/admininvite 哈希键语义)。
 */
export function invitationTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 接受邀请的 email 匹配判定:登录账号 email 与邀请 email 一致;
 * 账号无 email 时按 subject 兜底比对。
 */
export function invitationEmailMatches(
  account: { email: string | null; subject: string },
  invitedEmail: string,
): boolean {
  const identity = account.email ?? account.subject;
  return identity.trim().toLowerCase() === invitedEmail.trim().toLowerCase();
}
