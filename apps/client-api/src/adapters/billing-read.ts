/**
 * billing 表只读面（app-face join；accounts referralOverview 注释明示「totalCommission
 * 拆归 app 组合 G2，billing facade」）：邀请佣金累计和 = inviter 账户上 refType=referral
 * 且 refId 前缀 referral-commission: 的正向腿求和（v1 口径）。
 */
import { and, eq, gt, like, sql } from 'drizzle-orm';
import { walletAccounts, walletLegs, walletTransactions, type Db } from '@tokenlens/db';

export interface BillingRead {
  totalCommission(userId: number): Promise<string>;
}

export function createBillingRead(db: Db): BillingRead {
  return {
    async totalCommission(userId) {
      const rows = await db
        .select({
          total: sql<string>`coalesce(sum(${walletLegs.amount}), 0)::text`,
        })
        .from(walletLegs)
        .innerJoin(walletTransactions, eq(walletLegs.transactionId, walletTransactions.id))
        .innerJoin(walletAccounts, eq(walletLegs.accountId, walletAccounts.id))
        .where(
          and(
            eq(walletAccounts.userId, userId),
            eq(walletTransactions.refType, 'referral'),
            like(walletTransactions.refId, 'referral-commission:%'),
            gt(walletLegs.amount, '0'),
          ),
        );
      return rows[0]?.total ?? '0';
    },
  };
}
