import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, channels, users, userSubscriptions } from '@ai-gateway/db/schema';
import { toDecimal, toStorage } from '@ai-gateway/money';
import { settleClaim } from './settle.js';
import type {
  BillingEffects,
  BillingInventory,
  RecoveryRunResult,
  SettlementClaim,
  SettlementFailureClass,
  SettlementProcessorOptions,
  SettlementRunResult,
  UsageReceipt,
} from './types.js';

export interface BillingProcessor {
  runOnce(requestIds?: string[]): Promise<SettlementRunResult>;
  recoverOnce(): Promise<RecoveryRunResult>;
  inventory(): Promise<BillingInventory>;
  abandonOwnedClaims(): Promise<number>;
}

export interface BillingProcessorDeps {
  db: Db;
  options: SettlementProcessorOptions;
  effects?: BillingEffects;
  clock?: () => Date;
  random?: () => number;
}

type ClaimedRow = {
  request_id: string;
  claim_token: string;
  revision: number | string;
  settlement_attempts: number | string;
  receipt: UsageReceipt | string;
  claim_until: Date | string;
};

function decodeReceipt(value: UsageReceipt | string): UsageReceipt {
  const receipt = typeof value === 'string' ? (JSON.parse(value) as UsageReceipt) : value;
  const usage = receipt?.usage;
  const numeric = usage
    ? [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, receipt.durationMs]
    : [];
  const prices = receipt
    ? [receipt.inputPrice, receipt.outputPrice, receipt.cacheInputPrice, receipt.coefficient]
    : [];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.requestId !== 'string' ||
    !Number.isInteger(receipt.userId) ||
    receipt.userId <= 0 ||
    !usage ||
    numeric.some((item) => !Number.isFinite(item) || item < 0) ||
    prices.some((item) => typeof item !== 'string' || !toDecimal(item).isFinite()) ||
    typeof receipt.externalModel !== 'string' ||
    typeof receipt.realModel !== 'string' ||
    !Number.isInteger(receipt.mappingId) ||
    (receipt.billingPolicyFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(receipt.billingPolicyFingerprint))
  ) {
    throw new Error('poison_receipt');
  }
  return receipt;
}

function classifyFailure(error: unknown): SettlementFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === '40001' || code === '40P01') return 'serialization';
  // 23514 check_violation：信用模型下 balance < -credit_limit 触底（DB 约束 users_balance_credit_floor_ck）。
  // 归为 invariant_violation（永久）→ dead，待人工充值后 retry。
  if (code === '23514') return 'invariant_violation';
  if (code?.startsWith('08') || ['53300', '57P01', '57P02', '57P03'].includes(code ?? '')) {
    return 'db_transient';
  }
  if (message.includes('billing_user_missing')) return 'missing_subject';
  if (message.includes('receipt') || message.includes('JSON')) return 'poison_receipt';
  if (message.includes('invariant_') || message.includes('state_') || message.includes('mismatch'))
    return 'invariant_violation';
  return 'unknown';
}

function isPermanent(failure: SettlementFailureClass): boolean {
  return ['poison_receipt', 'invariant_violation', 'missing_subject'].includes(failure);
}

function retryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(random() * ceiling));
}

async function safeEffect(effect: (() => Promise<void>) | undefined): Promise<void> {
  if (!effect) return;
  try {
    await Promise.race([
      effect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('billing effect timeout')), 2_000),
      ),
    ]);
  } catch {
    // 投影失败不改变已提交的资金事务。
  }
}

/**
 * 多副本安全的结算处理器。所有业务重试状态都在 PostgreSQL；BullMQ 只负责 kick。
 */
export function createBillingProcessor({
  db,
  options,
  effects,
  clock = () => new Date(),
  random = Math.random,
}: BillingProcessorDeps): BillingProcessor {
  async function claim(requestIds?: string[]): Promise<SettlementClaim[]> {
    const limit = Math.min(options.batchSize, options.concurrency ?? 1);
    const idFilter = requestIds?.length
      ? sql`and request_id in (${sql.join(
          requestIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
    const rows = await db.transaction(async (tx) => {
      const result = await tx.execute<ClaimedRow>(sql`
        with candidates as (
          select request_id
          from billing_requests
          where status in ('settlement_pending', 'retry_wait')
            and (next_settlement_at is null or next_settlement_at <= clock_timestamp())
            ${idFilter}
          order by next_settlement_at nulls first, created_at
          for update skip locked
          limit ${limit}
        )
        update billing_requests b
        set status = 'processing',
            revision = b.revision + 1,
            settlement_attempts = b.settlement_attempts + 1,
            claim_owner = ${options.ownerId},
            claim_token = gen_random_uuid(),
            claim_until = clock_timestamp() + (${options.claimLeaseMs} * interval '1 millisecond'),
            failure_class = null,
            last_error = null,
            updated_at = clock_timestamp()
        from candidates c
        where b.request_id = c.request_id
        returning b.request_id, b.claim_token, b.revision, b.settlement_attempts,
                  b.receipt, b.claim_until
      `);
      return result.rows;
    });
    return rows.map((row) => ({
      requestId: row.request_id,
      ownerId: options.ownerId,
      claimToken: row.claim_token,
      revision: Number(row.revision),
      attempt: Number(row.settlement_attempts),
      receipt: row.receipt as unknown as UsageReceipt,
      claimedAt: clock(),
      claimUntil: new Date(row.claim_until),
    }));
  }

  async function finishFailure(
    claimed: SettlementClaim,
    error: unknown,
  ): Promise<'retried' | 'dead' | 'claim_lost'> {
    const failureClass = classifyFailure(error);
    const dead = isPermanent(failureClass) || claimed.attempt >= options.maxAttempts;
    const nextAt = dead
      ? null
      : retryDelayMs(claimed.attempt, options.retryBaseMs, options.retryMaxMs, random);
    const changed = await db
      .update(billingRequests)
      .set({
        status: dead ? 'dead' : 'retry_wait',
        revision: sql`${billingRequests.revision} + 1`,
        nextSettlementAt: dead
          ? null
          : sql`clock_timestamp() + (${nextAt} * interval '1 millisecond')`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        failureClass,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        deadAt: dead ? sql`clock_timestamp()` : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, claimed.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claimed.claimToken),
          eq(billingRequests.claimOwner, claimed.ownerId),
          eq(billingRequests.revision, claimed.revision),
          gt(billingRequests.claimUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ requestId: billingRequests.requestId });
    if (changed.length === 0) return 'claim_lost';
    return dead ? 'dead' : 'retried';
  }

  return {
    async runOnce(requestIds) {
      const result: SettlementRunResult = {
        claimed: 0,
        settled: 0,
        retried: 0,
        dead: 0,
        claimLost: 0,
      };
      let claims: SettlementClaim[];
      try {
        claims = await claim(requestIds);
      } catch (error) {
        if (classifyFailure(error) === 'poison_receipt') {
          // receipt 解码失败必须由 claim 级失败路径转 dead；claim() 不应吞掉数据库错误。
        }
        throw error;
      }
      result.claimed = claims.length;
      let renewal: Promise<void> = Promise.resolve();
      const renew = (): void => {
        renewal = renewal
          .then(async () => {
            const tokens = claims.map((item) => item.claimToken);
            if (tokens.length === 0) return;
            await db.execute(sql`
              update billing_requests
              set claim_until = clock_timestamp() + (${options.claimLeaseMs} * interval '1 millisecond'),
                  updated_at = clock_timestamp()
              where status = 'processing'
                and claim_owner = ${options.ownerId}
                and claim_token in (${sql.join(
                  tokens.map((token) => sql`${token}::uuid`),
                  sql`, `,
                )})
                and claim_until > clock_timestamp()
            `);
          })
          .catch(() => {});
      };
      const heartbeat = setInterval(renew, Math.max(250, Math.floor(options.claimLeaseMs / 3)));
      heartbeat.unref?.();
      try {
        await Promise.all(
          claims.map(async (claimed) => {
            try {
              claimed.receipt = decodeReceipt(claimed.receipt);
              const settled = await settleClaim(db, claimed);
              if (settled.outcome === 'settled') {
                result.settled += 1;
                await safeEffect(
                  () =>
                    effects?.usageSettled?.({ data: claimed.receipt, result: settled }) ??
                    Promise.resolve(),
                );
                await safeEffect(
                  () =>
                    effects?.balanceChanged?.({ userId: claimed.receipt.userId }) ??
                    Promise.resolve(),
                );
              } else {
                result.claimLost += 1;
              }
            } catch (error) {
              const outcome = await finishFailure(claimed, error);
              if (outcome === 'retried') result.retried += 1;
              else if (outcome === 'dead') result.dead += 1;
              else result.claimLost += 1;
            }
          }),
        );
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }
      return result;
    },

    async recoverOnce() {
      const now = clock();
      const recoveryBatchSize = options.recoveryBatchSize ?? options.batchSize;
      const result: RecoveryRunResult = { released: 0, uncertain: 0, claimsRequeued: 0 };

      // 资格判断与状态迁移在同一事务完成；授权未改已结算余额，只释放预留。
      await db.transaction(async (tx) => {
        const released = await tx.execute<{
          user_id: number;
          amount: string;
          plan_reserved_amount: string | null;
          subscription_id: number | null;
          channel_id: number | null;
          channel_reserved_amount: string | null;
        }>(sql`
          with candidates as (
            select request_id from billing_requests
            where status = 'authorized'
              and lease_expires_at <= clock_timestamp()
              and upstream_started_at is null
            order by lease_expires_at
            for update skip locked
            limit ${recoveryBatchSize}
          )
          update billing_requests b
          set status = 'released', revision = b.revision + 1,
              failure_code = 'authorization_expired_before_dispatch',
              lease_expires_at = null, released_at = clock_timestamp(), updated_at = clock_timestamp()
          from candidates c
          where b.request_id = c.request_id
            and b.status = 'authorized'
            and b.upstream_started_at is null
          returning b.user_id, b.reserved_amount as amount, b.plan_reserved_amount,
                    b.subscription_id, b.channel_id, b.channel_reserved_amount
        `);
        result.released = released.rows.length;
        for (const row of released.rows) {
          const planPart = row.plan_reserved_amount ?? '0';
          const paygPart = toStorage(toDecimal(row.amount).minus(toDecimal(planPart)));
          if (toDecimal(paygPart).gt(0)) {
            const reservation = await tx
              .update(users)
              .set({
                reservedBalance: sql`${users.reservedBalance} - ${paygPart}::numeric`,
                updatedAt: now,
              })
              .where(
                sql`${users.id} = ${row.user_id}
                    and ${users.reservedBalance} >= ${paygPart}::numeric`,
              )
              .returning({ id: users.id });
            if (reservation.length === 0) throw new Error('billing_reservation_invariant');
          }
          // 释放套餐在途敞口（若有）
          if (row.subscription_id != null && toDecimal(planPart).gt(0)) {
            const subReleased = await tx
              .update(userSubscriptions)
              .set({
                reservedAmount: sql`${userSubscriptions.reservedAmount} - ${planPart}::numeric`,
              })
              .where(
                sql`${userSubscriptions.id} = ${row.subscription_id}
                    and ${userSubscriptions.reservedAmount} >= ${planPart}::numeric`,
              )
              .returning({ id: userSubscriptions.id });
            if (subReleased.length === 0) throw new Error('subscription_reservation_invariant');
          }
          // 释放渠道在途敞口（若有：reserve 后未触达上游即过期）
          if (row.channel_id != null && row.channel_reserved_amount != null) {
            const channelReleased = await tx
              .update(channels)
              .set({
                upstreamReserved: sql`${channels.upstreamReserved} - ${row.channel_reserved_amount}::numeric`,
                updatedAt: now,
              })
              .where(
                sql`${channels.id} = ${row.channel_id}
                    and ${channels.upstreamReserved} >= ${row.channel_reserved_amount}::numeric`,
              )
              .returning({ id: channels.id });
            if (channelReleased.length === 0) throw new Error('channel_reservation_invariant');
          }
        }
      });

      const uncertain = await db.execute(sql`
        with candidates as (
          select request_id from billing_requests
          where status = 'in_flight' and lease_expires_at <= clock_timestamp()
          order by lease_expires_at for update skip locked limit ${recoveryBatchSize}
        )
        update billing_requests b set
          status = 'uncertain', revision = b.revision + 1,
          failure_code = 'in_flight_lease_expired', lease_expires_at = null, updated_at = clock_timestamp()
        from candidates c where b.request_id = c.request_id and b.status = 'in_flight'
        returning b.request_id
      `);
      result.uncertain = uncertain.rows.length;

      const requeued = await db.execute(sql`
        with candidates as (
          select request_id from billing_requests
          where status = 'processing' and claim_until <= clock_timestamp()
          order by claim_until for update skip locked limit ${recoveryBatchSize}
        )
        update billing_requests b set
          status = 'retry_wait', revision = b.revision + 1, next_settlement_at = clock_timestamp(),
          claim_owner = null, claim_token = null, claim_until = null,
          failure_class = 'claim_expired', last_error = 'settlement claim lease expired', updated_at = ${now}
        from candidates c where b.request_id = c.request_id and b.status = 'processing'
        returning b.request_id
      `);
      result.claimsRequeued = requeued.rows.length;
      return result;
    },

    async inventory() {
      const now = clock();
      const rows = await db.execute<{
        pending: string;
        processing: string;
        retrying: string;
        dead: string;
        uncertain: string;
        oldest_pending_at: Date | string | null;
      }>(sql`
        select
          count(*) filter (where status = 'settlement_pending')::text as pending,
          count(*) filter (where status = 'processing')::text as processing,
          count(*) filter (where status = 'retry_wait')::text as retrying,
          count(*) filter (where status = 'dead')::text as dead,
          count(*) filter (where status = 'uncertain')::text as uncertain,
          min(created_at) filter (where status in ('settlement_pending','processing','retry_wait')) as oldest_pending_at
        from billing_requests
      `);
      const row = rows.rows[0]!;
      const oldest = row.oldest_pending_at
        ? new Date(row.oldest_pending_at).getTime()
        : now.getTime();
      return {
        pending: Number(row.pending),
        processing: Number(row.processing),
        retrying: Number(row.retrying),
        dead: Number(row.dead),
        uncertain: Number(row.uncertain),
        oldestPendingMs: Math.max(0, now.getTime() - oldest),
      };
    },

    async abandonOwnedClaims() {
      const now = clock();
      const changed = await db
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
          and(
            eq(billingRequests.status, 'processing'),
            eq(billingRequests.claimOwner, options.ownerId),
          ),
        )
        .returning({ requestId: billingRequests.requestId });
      return changed.length;
    },
  };
}

export function newProcessorOwnerId(prefix = 'billing-worker'): string {
  return `${prefix}:${randomUUID()}`;
}
