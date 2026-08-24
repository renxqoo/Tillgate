/**
 * 计费链路的 PostgreSQL adapter：BillingStore（billing_requests/billing_reservations/
 * usage_logs 读侧 + 结算方法族）。订阅额度/渠道敞口/账户协作/订阅生命周期方法族
 * 按聚合边界拆分在同目录独立文件（铁律 5），此处组合。
 * 语义基准：旧仓 billing-request/billing-reservation/subscription/usage-log/channel
 * 各 repo 活路径逐方法平移；CAS 语义（WHERE status IN / revision+1 / 乐观锁）保持不变。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  billingRequests,
  billingReservations,
  isUniqueViolation,
  runTx,
  usageLogs,
  type Db,
  type DbTx,
  type TxRetryPolicy,
} from '@tillgate/db';
import type {
  BillingRequestRow,
  BillingReservationRow,
  BillingStore,
} from '../../ports/billing-store.js';
import type { SubscriptionQuotaStore } from '../../ports/funding-ports.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { WalletConn, WalletTx } from '../../ports/wallet-store.js';
import { createSubscriptionQuotaStore } from './subscription-quota-store.js';
import { createChannelExposureStore } from './channel-exposure-store.js';
import { createAccountContextStore } from './account-context-store.js';
import { subscriptionLifecycleMethods } from './billing-store-subscriptions.js';
import { adminMethods } from './billing-store-admin.js';
import { settlementMethods } from './billing-store-settlement.js';

export { createSubscriptionQuotaStore } from './subscription-quota-store.js';
export { createChannelExposureStore } from './channel-exposure-store.js';
export { createAccountContextStore } from './account-context-store.js';

export interface PostgresBillingStoreOptions {
  retry: TxRetryPolicy;
}

function asDb(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

function withBrand(tx: DbTx): WalletTx {
  return tx as unknown as WalletTx;
}

/** 在途账单状态集（sumExposure / 明细 JOIN 白名单共用） */
const IN_FLIGHT_STATUSES = [
  'authorized',
  'in_flight',
  'settlement_pending',
  'processing',
  'retry_wait',
  'dead',
] as const;

const REQUEST_COLUMNS = {
  requestId: billingRequests.requestId,
  userId: billingRequests.userId,
  apiKeyId: billingRequests.apiKeyId,
  channelId: billingRequests.channelId,
  channelReservedAmount: billingRequests.channelReservedAmount,
  planReservedAmount: billingRequests.planReservedAmount,
  subscriptionId: billingRequests.subscriptionId,
  estimatedExposureAmount: billingRequests.estimatedExposureAmount,
  reservedAmount: billingRequests.reservedAmount,
  status: billingRequests.status,
  revision: billingRequests.revision,
  stream: billingRequests.stream,
  quote: billingRequests.quote,
  authorizationFingerprint: billingRequests.authorizationFingerprint,
  traceParent: billingRequests.traceParent,
  receipt: billingRequests.receipt,
  receiptFingerprint: billingRequests.receiptFingerprint,
  leaseOwner: billingRequests.leaseOwner,
  leaseExpiresAt: billingRequests.leaseExpiresAt,
  failureCode: billingRequests.failureCode,
  settlementAttempts: billingRequests.settlementAttempts,
  nextSettlementAt: billingRequests.nextSettlementAt,
  claimOwner: billingRequests.claimOwner,
  claimToken: billingRequests.claimToken,
  claimUntil: billingRequests.claimUntil,
  createdAt: billingRequests.createdAt,
};

export function createPostgresBillingStore(
  db: Db,
  options: PostgresBillingStoreOptions,
): BillingStore & {
  quotaStore: SubscriptionQuotaStore;
  channelStore: ChannelExposureStore;
  accountContext: import('../../ports/account-context.js').AccountContextStore;
} {
  const { retry } = options;

  const store: BillingStore = {
    read: (fn) => fn(db as unknown as WalletConn),
    transaction: (fn) => runTx(db, (tx) => fn(withBrand(tx)), retry),
    joinTransaction: (tx, fn) => runTx(asDb(tx), (inner) => fn(withBrand(inner)), retry),

    async findByRequestId(conn, requestId) {
      const [row] = await asDb(conn)
        .select(REQUEST_COLUMNS)
        .from(billingRequests)
        .where(eq(billingRequests.requestId, requestId));
      return (row as BillingRequestRow | undefined) ?? null;
    },

    async advisoryLockAuthorizeUser(conn, userId) {
      await asDb(conn).execute(
        sql`select pg_advisory_xact_lock(hashtext('billing.authorize.user:' || ${userId}))`,
      );
    },

    async insertAuthorized(conn, input) {
      const rows = await asDb(conn)
        .insert(billingRequests)
        .values({
          requestId: input.requestId as `${string}-${string}-${string}-${string}-${string}`,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          estimatedExposureAmount: input.estimatedExposureAmount,
          reservedAmount: input.reservedAmount,
          planReservedAmount: input.planReservedAmount,
          subscriptionId: input.subscriptionId,
          stream: input.stream,
          quote: input.quote,
          authorizationFingerprint: input.authorizationFingerprint,
          traceParent: input.traceParent,
          leaseExpiresAt: input.leaseExpiresAt,
          nextSettlementAt: input.nextSettlementAt,
          createdAt: input.createdAt,
          status: 'authorized',
        })
        .onConflictDoNothing()
        .returning({ requestId: billingRequests.requestId });
      return rows.length > 0;
    },

    async casTransition(conn, input) {
      const rows = await asDb(conn)
        .update(billingRequests)
        .set({
          status: input.to,
          ...(input.set?.receipt !== undefined ? { receipt: input.set.receipt } : {}),
          ...(input.set?.receiptFingerprint !== undefined
            ? { receiptFingerprint: input.set.receiptFingerprint }
            : {}),
          ...(input.set?.leaseExpiresAt !== undefined
            ? { leaseExpiresAt: input.set.leaseExpiresAt }
            : {}),
          ...(input.set?.leaseOwner !== undefined ? { leaseOwner: input.set.leaseOwner } : {}),
          ...(input.set?.nextSettlementAt !== undefined
            ? { nextSettlementAt: input.set.nextSettlementAt }
            : {}),
          ...(input.set?.failureCode !== undefined ? { failureCode: input.set.failureCode } : {}),
          ...(input.set?.lastError !== undefined ? { lastError: input.set.lastError } : {}),
          ...(input.set?.releasedAt !== undefined ? { releasedAt: input.set.releasedAt } : {}),
          revision: sql`${billingRequests.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billingRequests.requestId, input.requestId),
            inArray(billingRequests.status, [...input.from]),
            // 续租 owner 守卫：仅当行 leaseOwner = 请求 owner 才命中（signal 的
            // lease.renewed 消费；缺省不校验，其余调用方行为不变）
            ...(input.expectLeaseOwner !== undefined
              ? [eq(billingRequests.leaseOwner, input.expectLeaseOwner)]
              : []),
          ),
        )
        .returning({ requestId: billingRequests.requestId });
      return rows.length > 0;
    },

    async casUpstreamStarted(conn, input) {
      const rows = await asDb(conn)
        .update(billingRequests)
        .set({
          status: 'in_flight',
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
          upstreamStartedAt: new Date(),
          revision: sql`${billingRequests.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billingRequests.requestId, input.requestId),
            inArray(billingRequests.status, ['authorized', 'in_flight']),
          ),
        )
        .returning({ requestId: billingRequests.requestId });
      return rows.length > 0;
    },

    async casClaimChannel(conn, input) {
      const rows = await asDb(conn)
        .update(billingRequests)
        .set({
          channelId: input.channelId,
          channelReservedAmount: input.channelReservedAmount,
          revision: sql`${billingRequests.revision} + 1`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(billingRequests.requestId, input.requestId),
            inArray(billingRequests.status, [...input.fromStatus]),
            // 乐观锁：channel 投影必须等于读到的旧值（IS NOT DISTINCT FROM 空值安全）
            sql`${billingRequests.channelId} is not distinct from ${input.expectedChannelId}`,
            sql`${billingRequests.channelReservedAmount} is not distinct from ${input.expectedReserved}`,
          ),
        )
        .returning({ requestId: billingRequests.requestId });
      return rows.length > 0;
    },

    async currentStatus(conn, requestId) {
      const [row] = await asDb(conn)
        .select({ status: billingRequests.status })
        .from(billingRequests)
        .where(eq(billingRequests.requestId, requestId));
      return row?.status ?? null;
    },

    async sumExposure(conn, input) {
      const conditions = [
        inArray(billingRequests.status, [...IN_FLIGHT_STATUSES]),
        sql`coalesce(${billingRequests.estimatedExposureAmount}, ${billingRequests.reservedAmount}) is not null`,
      ];
      if (input.userId !== undefined) conditions.push(eq(billingRequests.userId, input.userId));
      if (input.apiKeyId !== undefined)
        conditions.push(eq(billingRequests.apiKeyId, input.apiKeyId));
      if (input.subscriptionId !== undefined) {
        conditions.push(eq(billingRequests.subscriptionId, input.subscriptionId));
      }
      if (input.excludeRequestId !== undefined) {
        conditions.push(sql`${billingRequests.requestId} <> ${input.excludeRequestId}`);
      }
      const [row] = await asDb(conn)
        .select({
          total: sql<string>`coalesce(sum(coalesce(${billingRequests.estimatedExposureAmount}, ${billingRequests.reservedAmount})), 0)::numeric`,
        })
        .from(billingRequests)
        .where(and(...conditions));
      return row?.total ?? '0';
    },

    async inventory(conn, now) {
      const result = await asDb(conn).execute<{
        pending: number;
        retrying: number;
        oldest_pending_ms: number;
      }>(sql`
        select
          count(*) filter (where status = 'settlement_pending')::int as pending,
          count(*) filter (where status = 'retry_wait')::int as retrying,
          coalesce(max(extract(epoch from (${now.toISOString()}::timestamptz - created_at)) * 1000)
            filter (where status in ('settlement_pending', 'retry_wait')), 0)::float8 as oldest_pending_ms
        from billing_requests
        where status in ('settlement_pending', 'retry_wait')`);
      const row = result.rows[0];
      return {
        pending: row?.pending ?? 0,
        retrying: row?.retrying ?? 0,
        oldestPendingMs: row?.oldest_pending_ms ?? 0,
      };
    },

    async sumSettledSpend(conn, input) {
      const conditions = [eq(usageLogs.status, 0), sql`${usageLogs.createdAt} >= ${input.since}`];
      if (input.userId !== undefined) conditions.push(eq(usageLogs.userId, input.userId));
      if (input.apiKeyId !== undefined) conditions.push(eq(usageLogs.apiKeyId, input.apiKeyId));
      if (input.subscriptionId !== undefined) {
        conditions.push(eq(usageLogs.subscriptionId, input.subscriptionId));
      }
      const [row] = await asDb(conn)
        .select({ total: sql<string>`coalesce(sum(${usageLogs.calculatedAmount}), 0)::numeric` })
        .from(usageLogs)
        .where(and(...conditions));
      return row?.total ?? '0';
    },

    async insertReservation(conn, values) {
      const [row] = await asDb(conn)
        .insert(billingReservations)
        .values({ ...values, status: 'active' })
        .returning({ id: billingReservations.id });
      if (!row) throw new Error('billing.insert_reservation');
      return row.id;
    },

    async findActiveReservations(conn, billingRequestId, statuses) {
      const rows = await asDb(conn)
        .select({
          id: billingReservations.id,
          billingRequestId: billingReservations.billingRequestId,
          sourceType: billingReservations.sourceType,
          sourceRefId: billingReservations.sourceRefId,
          amount: billingReservations.amount,
          status: billingReservations.status,
        })
        .from(billingReservations)
        .innerJoin(
          billingRequests,
          eq(billingRequests.requestId, billingReservations.billingRequestId),
        )
        .where(
          and(
            eq(billingReservations.billingRequestId, billingRequestId),
            eq(billingReservations.status, 'active'),
            sql`${billingRequests.status} in ${[...(statuses ?? IN_FLIGHT_STATUSES)]}`,
          ),
        )
        .orderBy(billingReservations.id);
      return rows as BillingReservationRow[];
    },

    async markReservationReleased(conn, id, now) {
      const rows = await asDb(conn)
        .update(billingReservations)
        .set({ status: 'released', releasedAt: now })
        .where(and(eq(billingReservations.id, id), eq(billingReservations.status, 'active')))
        .returning({ id: billingReservations.id });
      return rows.length > 0;
    },

    async markReservationSettled(conn, id, now) {
      const rows = await asDb(conn)
        .update(billingReservations)
        .set({ status: 'settled', settledAt: now })
        .where(and(eq(billingReservations.id, id), eq(billingReservations.status, 'active')))
        .returning({ id: billingReservations.id });
      return rows.length > 0;
    },
    ...settlementMethods(db),

    ...subscriptionLifecycleMethods(db),
    ...adminMethods(db),

    isUniqueViolation: (error) => isUniqueViolation(error),
  };

  const quotaStore: SubscriptionQuotaStore = createSubscriptionQuotaStore(db);

  const channelStore: ChannelExposureStore = createChannelExposureStore(db);

  const accountContext = createAccountContextStore(db);

  return { ...store, quotaStore, channelStore, accountContext };
}
