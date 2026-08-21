/** referrals 仓储：邀请关系（invitee 唯一 = 一人只能被邀一次）与佣金日结聚合。 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { referrals, usageLogs, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

/** 邀请关系仓储（无状态；方法统一接收 RepoContext） */
export class ReferralRepository {
  /**
   * 建立邀请关系（并发兜底：referrals_invitee_uq 唯一索引，冲突返回 false）。
   * 只建关系不派奖——奖励入账在调用方（wallet 自然键幂等）。
   */
  async insertReferral(
    c: RepoContext,
    input: { inviterUserId: number; inviteeUserId: number },
  ): Promise<boolean> {
    const rows = await c.db
      .insert(referrals)
      .values({ inviterUserId: input.inviterUserId, inviteeUserId: input.inviteeUserId, status: 0 })
      .onConflictDoNothing({ target: referrals.inviteeUserId })
      .returning({ id: referrals.id });
    return rows.length > 0;
  }

  /** 邀请人是否为有效正常账号（封禁邀请人停止派奖） */
  async inviterActive(c: RepoContext, inviterUserId: number): Promise<boolean> {
    const [row] = await c.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, inviterUserId), eq(users.status, 0)));
    return row != null;
  }

  /** 我邀请的名单（最新在前，绑定被邀人昵称） */
  async listInviteesByInviter(
    c: RepoContext,
    inviterUserId: number,
    limit = 100,
  ): Promise<
    Array<{ inviteeUserId: number; inviteeName: string | null; status: number; createdAt: Date }>
  > {
    return c.db
      .select({
        inviteeUserId: referrals.inviteeUserId,
        inviteeName: users.displayName,
        status: referrals.status,
        createdAt: referrals.createdAt,
      })
      .from(referrals)
      .leftJoin(users, eq(users.id, referrals.inviteeUserId))
      .where(eq(referrals.inviterUserId, inviterUserId))
      .orderBy(desc(referrals.createdAt))
      .limit(limit);
  }

  /**
   * 佣金日结聚合：窗口内被邀请人的已结算消费按邀请人求和
   * （usage_logs.status=0 + referrals.status=0——作弊停止返佣）。
   */
  async sumInviteeSpendByInviter(
    c: RepoContext,
    window: { from: Date; to: Date },
  ): Promise<Array<{ inviterId: number; total: string }>> {
    return c.db
      .select({
        inviterId: referrals.inviterUserId,
        total: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric`,
      })
      .from(usageLogs)
      .innerJoin(referrals, eq(referrals.inviteeUserId, usageLogs.userId))
      .where(
        and(
          eq(usageLogs.status, 0),
          eq(referrals.status, 0),
          gte(usageLogs.createdAt, window.from),
          lt(usageLogs.createdAt, window.to),
        ),
      )
      .groupBy(referrals.inviterUserId);
  }
}
