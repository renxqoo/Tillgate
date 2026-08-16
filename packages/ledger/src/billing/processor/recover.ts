import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { BillingInvariantError } from '../errors.js';
import { releaseReservedAmounts } from '../release.js';
import type { RecoveryRunResult, SettlementProcessorOptions } from '../types.js';

/** 恢复作业（拆自 processor.ts，行为零变更）：三类滞留单的兜底状态迁移。 */

/** 三类预扣列的行形状（两条恢复路径共用） */
interface ReleaseRow extends Record<string, unknown> {
  user_id: number;
  amount: string;
  plan_reserved_amount: string | null;
  subscription_id: number | null;
  channel_id: number | null;
  channel_reserved_amount: string | null;
}

export async function recoverOnce(
  db: Db,
  options: SettlementProcessorOptions,
): Promise<RecoveryRunResult> {
  const recoveryBatchSize = options.recoveryBatchSize ?? options.batchSize;
  const result: RecoveryRunResult = { released: 0, claimsRequeued: 0 };

  // ① authorized 过期且从未发上游：资格判断与状态迁移同一事务，授权未改已结算余额，只释放预留。
  await db.transaction(async (tx) => {
    const released = await tx.execute<ReleaseRow>(sql`
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
      // 三类预扣投影同步释放（唯一实现 release.ts），错误语义保持原 invariant 命名
      await releaseReservedAmounts(
        tx,
        {
          userId: row.user_id,
          reservedAmount: row.amount,
          planReservedAmount: row.plan_reserved_amount,
          subscriptionId: row.subscription_id,
          channelId: row.channel_id,
          channelReservedAmount: row.channel_reserved_amount,
        },
        (dimension) =>
          new BillingInvariantError(
            dimension === 'user'
              ? 'billing_reservation_invariant'
              : `${dimension}_reservation_invariant`,
          ),
      );
    }
  });

  // ② in_flight 租约过期（网关崩溃）：2026-08-17 政策 → 释放不扣。
  // bytesRelayed 已随进程丢失、崩溃不可被攻击者操纵（无刷的风险），留痕 failure_code。
  // 资格判定、状态迁移与三类预扣投影释放在同一事务（与 authorized 过期分支同构）。
  const crashed = await db.transaction(async (tx) => {
    const rows = await tx.execute<ReleaseRow>(sql`
      with candidates as (
        select request_id from billing_requests
        where status = 'in_flight' and lease_expires_at <= clock_timestamp()
        order by lease_expires_at for update skip locked limit ${recoveryBatchSize}
      )
      update billing_requests b set
        status = 'released', revision = b.revision + 1,
        failure_code = 'gateway_crash_released', lease_expires_at = null,
        released_at = clock_timestamp(), updated_at = clock_timestamp()
      from candidates c where b.request_id = c.request_id and b.status = 'in_flight'
      returning b.user_id, b.reserved_amount as amount, b.plan_reserved_amount,
                b.subscription_id, b.channel_id, b.channel_reserved_amount
    `);
    for (const row of rows.rows) {
      // 三类预扣投影同步释放（唯一实现 release.ts）
      await releaseReservedAmounts(
        tx,
        {
          userId: row.user_id,
          reservedAmount: row.amount,
          planReservedAmount: row.plan_reserved_amount,
          subscriptionId: row.subscription_id,
          channelId: row.channel_id,
          channelReservedAmount: row.channel_reserved_amount,
        },
        () => new BillingInvariantError('gateway_crash_release_invariant'),
      );
    }
    return rows.rows.length;
  });
  result.released += crashed;

  // ③ processing 认领租约过期（worker 崩溃）：重回 retry_wait 立即可被重新认领
  const requeued = await db.execute(sql`
    with candidates as (
      select request_id from billing_requests
      where status = 'processing' and claim_until <= clock_timestamp()
      order by claim_until for update skip locked limit ${recoveryBatchSize}
    )
    update billing_requests b set
      status = 'retry_wait', revision = b.revision + 1, next_settlement_at = clock_timestamp(),
      claim_owner = null, claim_token = null, claim_until = null,
      failure_class = 'claim_expired', last_error = 'settlement claim lease expired', updated_at = clock_timestamp()
    from candidates c where b.request_id = c.request_id and b.status = 'processing'
    returning b.request_id
  `);
  result.claimsRequeued = requeued.rows.length;
  return result;
}
