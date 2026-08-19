/**
 * subscription/quota：套餐额度的预留/结算/释放原语（S3）。
 *
 * reserved/used 列的业务不变量在此下沉（守卫 UPDATE 单语句原子判定，
 * DB check 兜底）：used ≥ 0、reserved ≥ 0、used + reserved ≤ quota。
 * 消费方是 billing 域（授权预留 / 结算核销 / 失败释放）；额度不是钱，
 * 不进 wallet（plan §11 Q5 拍板）。
 */
import { eq, sql } from 'drizzle-orm';
import { userSubscriptions } from '@ai-gateway/db/schema';
import {
  BillingInvariantError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';

/**
 * 预留额度：reserved += amount，单语句守卫（status=0 且剩余额度足够）。
 * 0 行命中区分语义：订阅失效 → SubscriptionRequiredError；额度不足 →
 * SubscriptionQuotaExhaustedError（402，套餐额度永不为负）。
 */
export async function reserveQuota(
  tx: DomainTx,
  input: { subscriptionId: number; userId: number; amount: string },
): Promise<void> {
  const updated = await tx
    .update(userSubscriptions)
    .set({ reservedAmount: sql`${userSubscriptions.reservedAmount} + ${input.amount}::numeric` })
    .where(
      sql`${userSubscriptions.id} = ${input.subscriptionId}
          and ${userSubscriptions.status} = 0
          and ${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount}
              - ${userSubscriptions.reservedAmount} >= ${input.amount}::numeric`,
    )
    .returning({ id: userSubscriptions.id });
  if (updated.length === 0) {
    const sub = await tx.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, input.subscriptionId),
      columns: { status: true },
    });
    if (!sub || sub.status !== 0) throw new SubscriptionRequiredError(input.userId);
    throw new SubscriptionQuotaExhaustedError(input.userId, '0', input.amount);
  }
}

/**
 * 结算核销：reserved −= reserved（释放本单预占）+ used += consumed（实际消费）。
 * 单语句守卫 reserved 足额与 used + consumed + reserved_after ≤ quota；
 * 0 行命中 = 账单与额度事实脱节（invariant 红灯 → dead 人工）。
 */
export async function settleQuota(
  tx: DomainTx,
  input: { subscriptionId: number; reserved: string; consumed: string },
): Promise<void> {
  const updated = await tx
    .update(userSubscriptions)
    .set({
      reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric`,
      usedAmount: sql`${userSubscriptions.usedAmount} + ${input.consumed}::numeric`,
    })
    .where(
      sql`${userSubscriptions.id} = ${input.subscriptionId}
          and ${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric
          and ${userSubscriptions.usedAmount} + ${input.consumed}::numeric
              + (${userSubscriptions.reservedAmount} - ${input.reserved}::numeric)
              <= ${userSubscriptions.quotaAmount}`,
    )
    .returning({ id: userSubscriptions.id });
  if (updated.length === 0) throw new BillingInvariantError('subscription_quota_invariant');
}

/**
 * 释放预占：reserved −= reserved（失败/取消/回收路径）。
 * 0 行命中 = 额度在途事实脱节（invariant 红灯）。
 */
export async function releaseQuota(
  tx: DomainTx,
  input: { subscriptionId: number; reserved: string },
): Promise<void> {
  const updated = await tx
    .update(userSubscriptions)
    .set({ reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric` })
    .where(
      sql`${userSubscriptions.id} = ${input.subscriptionId}
          and ${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric`,
    )
    .returning({ id: userSubscriptions.id });
  if (updated.length === 0) {
    throw new BillingInvariantError('subscription_reservation_invariant');
  }
}
