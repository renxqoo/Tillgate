/**
 * billing-store 的订阅生命周期 + 操作档案方法族（plans/user_subscriptions/
 * ledger_operations）——按聚合边界拆分（铁律 5）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { ledgerOperations, plans, userSubscriptions, type Db, type DbTx } from '@tokenlens/db';
import type { BillingStore } from '../../ports/billing-store.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

const SUB_COLUMNS = {
  id: userSubscriptions.id,
  userId: userSubscriptions.userId,
  planId: userSubscriptions.planId,
  orgId: userSubscriptions.orgId,
  quantity: userSubscriptions.quantity,
  price: userSubscriptions.price,
  status: userSubscriptions.status,
  startAt: userSubscriptions.startAt,
  endAt: userSubscriptions.endAt,
  quotaAmount: userSubscriptions.quotaAmount,
  usedAmount: userSubscriptions.usedAmount,
  reservedAmount: userSubscriptions.reservedAmount,
};

export function subscriptionLifecycleMethods(
  db: Db,
): Pick<
  BillingStore,
  | 'findPlan'
  | 'lockActiveSubscription'
  | 'lockActiveSubscriptionForUser'
  | 'expireLapsedSubscriptions'
  | 'insertSubscription'
  | 'casSubscriptionStatus'
  | 'tryAddQuota'
  | 'insertOperationPlaceholder'
  | 'findOperation'
  | 'saveOperationReceipt'
> {
  void db;
  return {
    async findPlan(conn: WalletConn, planId: number) {
      const [row] = await tx(conn)
        .select({
          id: plans.id,
          name: plans.name,
          kind: plans.kind,
          sortOrder: plans.sortOrder,
          price: plans.price,
          periodDays: plans.periodDays,
          quotaAmount: plans.quotaAmount,
          allowSeats: plans.allowSeats,
          status: plans.status,
        })
        .from(plans)
        .where(eq(plans.id, planId));
      return row ?? null;
    },

    async lockActiveSubscription(conn: WalletConn, subscriptionId: number) {
      const [row] = await tx(conn)
        .select(SUB_COLUMNS)
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.id, subscriptionId), eq(userSubscriptions.status, 0)))
        .for('update');
      return (row as import('../../ports/billing-store.js').SubscriptionRow | undefined) ?? null;
    },

    async lockActiveSubscriptionForUser(conn: WalletConn, userId: number, now: Date) {
      const [row] = await tx(conn)
        .select(SUB_COLUMNS)
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, userId),
            eq(userSubscriptions.status, 0),
            sql`${userSubscriptions.endAt} > ${now}`,
          ),
        )
        .for('update');
      return (row as import('../../ports/billing-store.js').SubscriptionRow | undefined) ?? null;
    },

    async expireLapsedSubscriptions(conn: WalletConn, userId: number, now: Date) {
      await tx(conn)
        .update(userSubscriptions)
        .set({ status: 1 })
        .where(
          and(
            eq(userSubscriptions.userId, userId),
            eq(userSubscriptions.status, 0),
            sql`${userSubscriptions.endAt} <= ${now}`,
          ),
        );
    },

    async insertSubscription(
      conn: WalletConn,
      values: Parameters<BillingStore['insertSubscription']>[1],
    ) {
      const [row] = await tx(conn)
        .insert(userSubscriptions)
        .values(values)
        .returning({ id: userSubscriptions.id });
      if (!row) throw new Error('billing.insert_subscription');
      return row.id;
    },

    async casSubscriptionStatus(
      conn: WalletConn,
      input: { subscriptionId: number; from: number; to: number },
    ) {
      const rows = await tx(conn)
        .update(userSubscriptions)
        .set({ status: input.to })
        .where(
          and(
            eq(userSubscriptions.id, input.subscriptionId),
            eq(userSubscriptions.status, input.from),
          ),
        )
        .returning({ id: userSubscriptions.id });
      return rows.length > 0;
    },

    async tryAddQuota(conn: WalletConn, input: { subscriptionId: number; quota: string }) {
      const rows = await tx(conn)
        .update(userSubscriptions)
        .set({ quotaAmount: sql`${userSubscriptions.quotaAmount} + ${input.quota}::numeric` })
        .where(and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)))
        .returning({ id: userSubscriptions.id });
      return rows.length > 0;
    },

    async insertOperationPlaceholder(
      conn: WalletConn,
      input: { operationId: string; kind: string; fingerprint: string },
    ) {
      const rows = await tx(conn)
        .insert(ledgerOperations)
        .values(input)
        .onConflictDoNothing({ target: ledgerOperations.operationId })
        .returning({ id: ledgerOperations.id });
      return rows[0]?.id ?? null;
    },

    async findOperation(conn: WalletConn, operationId: string) {
      const [row] = await tx(conn)
        .select({
          id: ledgerOperations.id,
          operationId: ledgerOperations.operationId,
          kind: ledgerOperations.kind,
          fingerprint: ledgerOperations.fingerprint,
          receipt: ledgerOperations.receipt,
        })
        .from(ledgerOperations)
        .where(eq(ledgerOperations.operationId, operationId));
      return (
        (row as
          | {
              id: number;
              operationId: string;
              kind: string;
              fingerprint: string;
              receipt: Record<string, unknown> | null;
            }
          | undefined) ?? null
      );
    },

    async saveOperationReceipt(conn: WalletConn, id: number, receipt: Record<string, unknown>) {
      await tx(conn)
        .update(ledgerOperations)
        .set({ receipt, updatedAt: new Date() })
        .where(eq(ledgerOperations.id, id));
    },
  };
}
