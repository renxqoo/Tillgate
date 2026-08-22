/**
 * 组织/邀请域规则:待接受上限公式、邀请 token 形态、成员角色词汇。
 * 席位不变量的权威编排在 accept 事务(application);此处是纯计算。
 */
import { randomUUID } from 'node:crypto';

/** 成员角色词汇(org_members.role DDL 契约) */
export const MEMBER_ROLES = { OWNER: 'owner', MEMBER: 'member' } as const;

export type MemberRole = (typeof MEMBER_ROLES)[keyof typeof MEMBER_ROLES];

export interface InvitationPendingPolicy {
  /** 待接受上限 = min(max(剩余席位, 1) × factor, cap)(v1 等价 factor=2, cap=20) */
  readonly factor: number;
  readonly cap: number;
}

/**
 * 待接受邀请上限(v1 org.service.ts:141 写死 min(max(剩余,1)×2, 20),此处显式注入)。
 * 允许 pending 总数超过剩余席位——防刷邀请行的有意设计,与席位闸并存(v1 测试锁定)。
 */
export function pendingInvitationLimit(
  remainingSeats: number,
  policy: InvitationPendingPolicy,
): number {
  const base = Math.max(remainingSeats, 1);
  return Math.min(base * policy.factor, policy.cap);
}

/** 生成邀请 token:32 hex(uuid 去杠,v1 形态);只在创建响应下发一次 */
export function generateInvitationToken(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * 接受邀请的 email 匹配判定:登录账号 email 与邀请 email 一致;
 * 账号无 email 时按 subject 兜底比对(v1 org.service 语义)。
 */
export function invitationEmailMatches(
  account: { email: string | null; subject: string },
  invitedEmail: string,
): boolean {
  const identity = account.email ?? account.subject;
  return identity.trim().toLowerCase() === invitedEmail.trim().toLowerCase();
}
