/**
 * settlement/recover（S6 平移自 billing/processor/recover.ts）：三类滞留单兜底。
 * 释放路径换 billing/release-reservations（wallet + quota + channel 三路）。
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import { releaseReservations } from '../billing/release-reservations.js';
import type { RecoveryRunResult, SettlementProcessorOptions } from '../billing/types.js';

/** 三类预扣列的行形状（两条恢复路径共用） */
interface ReleaseRow extends Record<string, unknown> {
  request_id: string;
  user_id: number;
  amount: string;
  plan_reserved_amount: string | null;
  subscription_id: number | null;
  channel_id: number | null;
  channel_reserved_amount: string | null;
}

export async function recoverOnce(
  db: Db,
  wallet: Wallet,
  options: SettlementProcessorOptions,
): Promise<RecoveryRunResult> {
  const recoveryBatchSize = options.recoveryBatchSize ?? options.batchSize;
  const result: RecoveryRunResult = { released: 0, claimsRequeued: 0 };

  // ① authorized 过期且从未发上游：资格判断与状态迁移同一事务，授权未动余额，只释放预占。
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
      returning b.request_id, b.user_id, b.reserved_amount as amount, b.plan_reserved_amount,
                b.subscription_id, b.channel_id, b.channel_reserved_amount
    `);
    result.released = released.rows.length;
    for (const row of released.rows) {
      await releaseReservations(wallet, tx, {
        requestId: row.request_id,
        userId: row.user_id,
        reservedAmount: row.amount,
        planReservedAmount: row.plan_reserved_amount,
        subscriptionId: row.subscription_id,
        channelId: row.channel_id,
        channelReservedAmount: row.channel_reserved_amount,
      });
    }
  });

  // ② in_flight 租约过期（网关崩溃）：释放不扣（2026-08-17 政策），留痕 failure_code。
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
      returning b.request_id, b.user_id, b.reserved_amount as amount, b.plan_reserved_amount,
                b.subscription_id, b.channel_id, b.channel_reserved_amount
    `);
    for (const row of rows.rows) {
      await releaseReservations(wallet, tx, {
        requestId: row.request_id,
        userId: row.user_id,
        reservedAmount: row.amount,
        planReservedAmount: row.plan_reserved_amount,
        subscriptionId: row.subscription_id,
        channelId: row.channel_id,
        channelReservedAmount: row.channel_reserved_amount,
      });
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
