/**
 * 计费链路的 PostgreSQL adapter：BillingStore（billing_requests/billing_reservations/
 * usage_logs 读侧）+ SubscriptionQuotaStore（user_subscriptions/org_members）+
 * ChannelExposureStore（channels 守卫原子 UPDATE 族）。
 * 语义基准：旧仓 billing-request/billing-reservation/subscription/usage-log/channel
 * 各 repo 活路径逐方法平移；CAS 语义（WHERE status IN / revision+1 / 乐观锁）保持不变。
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  billingRequests,
  billingReservations,
  isUniqueViolation,
  orgMembers,
  runTx,
  usageLogs,
  userSubscriptions,
  channels,
  type Db,
  type DbTx,
  type TxRetryPolicy,
} from '@tokenlens/db';
import type {
  BillingRequestRow,
  BillingReservationRow,
  BillingStore,
} from '../../ports/billing-store.js';
import type {
  ChannelExposureStore,
  SubscriptionQuotaStore,
  SubscriptionSnapshot,
} from '../../ports/funding-ports.js';
import type { WalletConn, WalletTx } from '../../ports/wallet-store.js';

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

    isUniqueViolation: (error) => isUniqueViolation(error),
  };

  const quotaStore: SubscriptionQuotaStore = {
    async activeSubscriptionSnapshot(conn, subscriptionId, now) {
      const [row] = await asDb(conn)
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

    async memberLimits(conn, input) {
      const [row] = await asDb(conn)
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

    async tryReserveQuota(conn, input) {
      const rows = await asDb(conn)
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
      const [alive] = await asDb(conn)
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)),
        );
      return alive ? 'exhausted' : 'inactive';
    },

    async tryReleaseQuota(conn, input) {
      const rows = await asDb(conn)
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

    async trySettleQuota(conn, input) {
      const rows = await asDb(conn)
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

  const channelStore: ChannelExposureStore = {
    async findChannel(conn, channelId) {
      const [row] = await asDb(conn)
        .select({
          upstreamBudget: channels.upstreamBudget,
          upstreamReserved: channels.upstreamReserved,
        })
        .from(channels)
        .where(eq(channels.id, channelId));
      return row ?? null;
    },

    async tryIncreaseReserved(conn, input) {
      const rows = await asDb(conn)
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} + ${input.delta}::numeric`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(channels.id, input.channelId),
            sql`${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${input.delta}::numeric`,
          ),
        )
        .returning({
          budget: channels.upstreamBudget,
          reserved: channels.upstreamReserved,
        });
      return rows[0] ?? null;
    },

    async tryDecreaseReserved(conn, input) {
      const rows = await asDb(conn)
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} - ${input.amount}::numeric`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(channels.id, input.channelId),
            sql`${channels.upstreamReserved} >= ${input.amount}::numeric`,
          ),
        )
        .returning({ id: channels.id });
      return rows.length > 0;
    },

    async deductBudgetAndMaybeBreak(conn, input) {
      // 熔断判定在 SQL 侧（numeric 精确比较）——JS 侧字符串比较是字典序（'9' <= '10' 为 false）
      const rows = await asDb(conn)
        .update(channels)
        .set({
          upstreamBudget: sql`${channels.upstreamBudget} - ${input.upstreamCost}::numeric`,
          updatedAt: input.now,
        })
        .where(eq(channels.id, input.channelId))
        .returning({
          broken: sql<boolean>`(${channels.upstreamBudget} <= coalesce(${channels.upstreamThreshold}, 0))`,
        });
      const row = rows[0];
      if (!row) return false;
      if (row.broken) {
        await asDb(conn)
          .update(channels)
          .set({ status: 3, updatedAt: input.now })
          .where(and(eq(channels.id, input.channelId), eq(channels.status, 0)));
        return true;
      }
      return false;
    },
  };

  void desc;
  void lt;
  return { ...store, quotaStore, channelStore };
}
