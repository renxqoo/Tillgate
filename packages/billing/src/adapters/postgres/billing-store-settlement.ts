/**
 * billing-store 的结算方法族（认领/租约/五元组 CAS/恢复三路径/usage 投影）——
 * 按聚合边界拆分（铁律 5）。SQL 语义原样：CTE + FOR UPDATE SKIP LOCKED、
 * clock_timestamp 租约、恢复守卫。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { billingRequests, usageLogs, type Db, type DbTx } from '@tillgate/db';
import type { BillingRequestRow, BillingStore } from '../../ports/billing-store.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

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

// eslint-disable-next-line max-lines-per-function -- 结算投影 SQL 构造平铺
export function settlementMethods(
  db: Db,
): Pick<
  BillingStore,
  | 'claimPending'
  | 'listDueSettlementRequests'
  | 'renewClaims'
  | 'findProcessingForClaim'
  | 'casFinalizeSettled'
  | 'casToRetryOrDead'
  | 'listExpiredForRecovery'
  | 'recoverOneToReleased'
  | 'requeueExpiredClaims'
  | 'abandonOwnedClaims'
  | 'insertUsageLog'
  | 'findUsageAmount'
> {
  void db;
  void billingRequests;
  void usageLogs;
  void and;
  void eq;
  void inArray;
  void sql;
  void tx;
  void db;
  return {
    async claimPending(conn, input) {
      const idFilter =
        input.requestIds && input.requestIds.length > 0
          ? sql`and request_id in (${sql.join(
              input.requestIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``;
      const result = await tx(conn).execute<{
        request_id: string;
        claim_token: string;
        revision: string | number;
        attempt: string | number;
        settlement_attempts: string | number;
        receipt: Record<string, unknown> | null;
        trace_parent: string | null;
      }>(sql`
        with candidates as (
          select request_id from billing_requests
          where status in ('settlement_pending', 'retry_wait')
            and (next_settlement_at is null or next_settlement_at <= clock_timestamp())
            ${idFilter}
          order by next_settlement_at nulls first, created_at
          for update skip locked
          limit ${input.batchSize}
        )
        update billing_requests b
        set status = 'processing',
            revision = b.revision + 1,
            settlement_attempts = b.settlement_attempts + 1,
            claim_owner = ${input.ownerId},
            claim_token = gen_random_uuid(),
            claim_until = clock_timestamp() + (${input.claimLeaseMs} * interval '1 millisecond'),
            failure_class = null,
            last_error = null,
            updated_at = clock_timestamp()
        from candidates c2
        where b.request_id = c2.request_id
        returning b.request_id, b.claim_token, b.revision,
                  b.settlement_attempts as attempt, b.receipt, b.trace_parent`);
      return result.rows.map((row) => ({
        requestId: row.request_id,
        claimToken: row.claim_token,
        revision: Number(row.revision),
        attempt: Number(row.settlement_attempts),
        receipt: row.receipt,
        traceParent: row.trace_parent,
      }));
    },

    async listDueSettlementRequests(conn, input) {
      const result = await tx(conn).execute<{ request_id: string }>(sql`
        select request_id from billing_requests
        where status in ('settlement_pending', 'retry_wait')
          and (next_settlement_at is null or next_settlement_at <= clock_timestamp())
        order by next_settlement_at nulls first, created_at
        limit ${input.limit}`);
      return result.rows.map((row) => row.request_id);
    },

    async renewClaims(conn, input) {
      if (input.tokens.length === 0) return;
      await tx(conn).execute(sql`
        update billing_requests
        set claim_until = clock_timestamp() + (${input.claimLeaseMs} * interval '1 millisecond'),
            updated_at = clock_timestamp()
        where status = 'processing'
          and claim_owner = ${input.ownerId}
          and claim_token in (${sql.join(
            input.tokens.map((token) => sql`${token}::uuid`),
            sql`, `,
          )})
          and claim_until > clock_timestamp()`);
    },
    async findProcessingForClaim(conn, claim) {
      const [row] = await tx(conn)
        .select(REQUEST_COLUMNS)
        .from(billingRequests)
        .where(
          and(
            eq(billingRequests.requestId, claim.requestId),
            eq(billingRequests.status, 'processing'),
            eq(billingRequests.claimToken, claim.claimToken),
            eq(billingRequests.claimOwner, claim.ownerId),
            eq(billingRequests.revision, claim.revision),
            sql`${billingRequests.claimUntil} > clock_timestamp()`,
          ),
        );
      return (row as BillingRequestRow | undefined) ?? null;
    },

    async casFinalizeSettled(conn, claim) {
      const rows = await tx(conn)
        .update(billingRequests)
        .set({
          status: 'settled',
          revision: sql`${billingRequests.revision} + 1`,
          claimOwner: null,
          claimToken: null,
          claimUntil: null,
          settledAt: sql`clock_timestamp()`,
          nextSettlementAt: null,
          lastError: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(billingRequests.requestId, claim.requestId),
            eq(billingRequests.status, 'processing'),
            eq(billingRequests.claimToken, claim.claimToken),
            eq(billingRequests.claimOwner, claim.ownerId),
            eq(billingRequests.revision, claim.revision),
            sql`${billingRequests.claimUntil} > clock_timestamp()`,
          ),
        )
        .returning({ id: billingRequests.requestId });
      return rows.length > 0;
    },

    async casToRetryOrDead(conn, claim, input) {
      const rows = await tx(conn)
        .update(billingRequests)
        .set({
          status: input.dead ? 'dead' : 'retry_wait',
          revision: sql`${billingRequests.revision} + 1`,
          nextSettlementAt: input.dead
            ? null
            : sql`clock_timestamp() + (${input.nextDelayMs} * interval '1 millisecond')`,
          claimOwner: null,
          claimToken: null,
          claimUntil: null,
          failureClass: input.failureClass,
          lastError: input.lastError.slice(0, 4000),
          deadAt: input.dead ? sql`clock_timestamp()` : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(billingRequests.requestId, claim.requestId),
            eq(billingRequests.status, 'processing'),
            eq(billingRequests.claimToken, claim.claimToken),
            eq(billingRequests.claimOwner, claim.ownerId),
            eq(billingRequests.revision, claim.revision),
            sql`${billingRequests.claimUntil} > clock_timestamp()`,
          ),
        )
        .returning({ id: billingRequests.requestId });
      return rows.length > 0;
    },

    async listExpiredForRecovery(conn, input) {
      const upstreamGuard =
        input.status === 'authorized' ? sql`and upstream_started_at is null` : sql``;
      const result = await tx(conn).execute<{ request_id: string }>(sql`
        select request_id from billing_requests
        where status = ${input.status}
          and lease_expires_at <= clock_timestamp()
          ${upstreamGuard}
        order by lease_expires_at
        limit ${input.limit}`);
      return result.rows.map((row) => row.request_id);
    },

    async recoverOneToReleased(conn, input) {
      const upstreamGuard =
        input.status === 'authorized' ? sql`and upstream_started_at is null` : sql``;
      const leaseGuard =
        input.status === 'authorized' ? sql`` : sql`and lease_expires_at <= clock_timestamp()`;
      const result = await tx(conn).execute<{
        request_id: string;
        reserved_amount: string;
        channel_id: number | null;
        channel_reserved_amount: string | null;
      }>(sql`
        update billing_requests b
        set status = 'released', revision = b.revision + 1,
          failure_code = ${input.failureCode},
          lease_expires_at = null, released_at = clock_timestamp(), updated_at = clock_timestamp()
        where b.request_id = ${input.requestId} and b.status = ${input.status}
          ${upstreamGuard} ${leaseGuard}
        returning b.request_id, b.reserved_amount, b.channel_id, b.channel_reserved_amount`);
      const [row] = result.rows;
      return row
        ? {
            requestId: row.request_id,
            reservedAmount: row.reserved_amount,
            channelId: row.channel_id,
            channelReservedAmount: row.channel_reserved_amount,
          }
        : null;
    },

    async requeueExpiredClaims(conn, limit) {
      const result = await tx(conn).execute(sql`
        with candidates as (
          select request_id from billing_requests
          where status = 'processing' and claim_until <= clock_timestamp()
          order by claim_until for update skip locked limit ${limit}
        )
        update billing_requests b set
          status = 'retry_wait', revision = b.revision + 1,
          next_settlement_at = clock_timestamp(),
          claim_owner = null, claim_token = null, claim_until = null,
          failure_class = 'claim_expired', last_error = 'settlement claim lease expired',
          updated_at = clock_timestamp()
        from candidates c2 where b.request_id = c2.request_id and b.status = 'processing'
        returning b.request_id`);
      return result.rows.length;
    },

    async abandonOwnedClaims(conn, ownerId, now) {
      const rows = await tx(conn)
        .update(billingRequests)
        .set({
          status: 'retry_wait',
          revision: sql`${billingRequests.revision} + 1`,
          nextSettlementAt: now,
          claimOwner: null,
          claimToken: null,
          claimUntil: null,
          failureClass: 'claim_expired',
          lastError: 'worker shutdown returned claim',
          updatedAt: now,
        })
        .where(
          and(eq(billingRequests.status, 'processing'), eq(billingRequests.claimOwner, ownerId)),
        )
        .returning({ id: billingRequests.requestId });
      return rows.length;
    },

    async insertUsageLog(conn, values) {
      const rows = await tx(conn)
        .insert(usageLogs)
        .values(values as typeof usageLogs.$inferInsert)
        .onConflictDoNothing({ target: usageLogs.requestId })
        .returning({ id: usageLogs.id });
      return rows.length > 0;
    },

    async findUsageAmount(conn, requestId) {
      const [row] = await tx(conn)
        .select({ amount: usageLogs.amount })
        .from(usageLogs)
        .where(eq(usageLogs.requestId, requestId));
      return row?.amount ?? null;
    },
  };
}
