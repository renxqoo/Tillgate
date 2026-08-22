/**
 * 订阅额度守卫三原语 + 快照/成员限额的 PostgreSQL adapter（user_subscriptions/org_members）。
 * 从 billing-store 拆出（聚合边界：订阅行操作独立成文件——铁律 5）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { orgMembers, userSubscriptions, type Db, type DbTx } from '@tokenlens/db';
import type { SubscriptionQuotaStore, SubscriptionSnapshot } from '../../ports/funding-ports.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

export function createSubscriptionQuotaStore(_db: Db): SubscriptionQuotaStore {
  return {
    async activeSubscriptionSnapshot(conn: WalletConn, subscriptionId: number, now: Date) {
      const [row] = await tx(conn)
        .select({
          userId: userSubscriptions.userId,
          orgId: userSubscriptions.orgId,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
        })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.id, subscriptionId),
            eq(userSubscriptions.status, 0),
            sql`${userSubscriptions.endAt} > ${now}`,
          ),
        );
      return (row as SubscriptionSnapshot | undefined) ?? null;
    },

    async memberLimits(conn: WalletConn, input: { orgId: number; userId: number }) {
      const [row] = await tx(conn)
        .select({
          dailySpendLimit: orgMembers.dailySpendLimit,
          monthlyQuota: orgMembers.monthlyQuota,
        })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, input.orgId),
            eq(orgMembers.userId, input.userId),
            eq(orgMembers.status, 1),
          ),
        );
      return row ?? null;
    },

    async tryReserveQuota(conn: WalletConn, input: { subscriptionId: number; amount: string }) {
      const rows = await tx(conn)
        .update(userSubscriptions)
        .set({
          reservedAmount: sql`${userSubscriptions.reservedAmount} + ${input.amount}::numeric`,
        })
        .where(
          and(
            eq(userSubscriptions.id, input.subscriptionId),
            eq(userSubscriptions.status, 0),
            sql`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount} >= ${input.amount}::numeric`,
          ),
        )
        .returning({ id: userSubscriptions.id });
      if (rows.length > 0) return 'ok';
      const [alive] = await tx(conn)
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)),
        );
      return alive ? 'exhausted' : 'inactive';
    },

    async tryReleaseQuota(conn: WalletConn, input: { subscriptionId: number; reserved: string }) {
      const rows = await tx(conn)
        .update(userSubscriptions)
        .set({
          reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric`,
        })
        .where(
          and(
            eq(userSubscriptions.id, input.subscriptionId),
            sql`${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric`,
          ),
        )
        .returning({ id: userSubscriptions.id });
      return rows.length > 0;
    },

    async trySettleQuota(
      conn: WalletConn,
      input: { subscriptionId: number; reserved: string; consumed: string },
    ) {
      const rows = await tx(conn)
        .update(userSubscriptions)
        .set({
          reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric`,
          usedAmount: sql`${userSubscriptions.usedAmount} + ${input.consumed}::numeric`,
        })
        .where(
          and(
            eq(userSubscriptions.id, input.subscriptionId),
            sql`${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric`,
            sql`${userSubscriptions.usedAmount} + ${input.consumed}::numeric + (${userSubscriptions.reservedAmount} - ${input.reserved}::numeric) <= ${userSubscriptions.quotaAmount}`,
          ),
        )
        .returning({ id: userSubscriptions.id });
      return rows.length > 0;
    },
  };
}
