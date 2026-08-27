/**
 * CommissionStatsStore 生产适配器（usage_logs × referrals × users 只读聚合）。
 * SQL 只住本目录。
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '@tillgate/db';
import { referrals, usageLogs, users } from '@tillgate/db';
import type { CommissionStatsStore, InviteeSpendByInviter } from '../../ports/commission-stats.js';

export function createPostgresCommissionStatsStore(db: Db): CommissionStatsStore {
  return {
    async sumInviteeSpendByInviter(input): Promise<InviteeSpendByInviter[]> {
      const rows = await db
        .select({
          inviterId: referrals.inviterUserId,
          total: sql<string>`coalesce(sum(${usageLogs.amount}), 0)`,
        })
        .from(usageLogs)
        .innerJoin(referrals, eq(referrals.inviteeUserId, usageLogs.userId))
        .innerJoin(users, eq(users.id, referrals.inviterUserId))
        .where(
          and(
            eq(usageLogs.status, 0),
            eq(referrals.status, 0),
            eq(users.status, 0),
            gte(usageLogs.createdAt, input.from),
            lt(usageLogs.createdAt, input.to),
          ),
        )
        .groupBy(referrals.inviterUserId);
      return rows.map((row) => ({ inviterId: row.inviterId, total: row.total }));
    },
  };
}
