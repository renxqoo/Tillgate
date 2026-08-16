import { and, eq, sql } from 'drizzle-orm';
import { Decimal, toDecimal } from '@ai-gateway/money';
import { channels } from '@ai-gateway/db/schema';
import { BillingInvariantError } from '../errors.js';
import type { DbTx, ReservationProjectionRow, UsageReceipt } from '../types.js';

/**
 * 渠道收尾（拆自 settleClaim）：
 *
 *   releaseChannelExposure  结算前释放渠道在途敞口（本请求预留的上游成本预估）
 *   deductChannelBudget     结算后按真实上游成本扣减进货额度；余额 ≤ 阈值 → 熔断
 *                           status=3（渠道级软闸，worker 会 bump 路由缓存）
 */
export async function releaseChannelExposure(
  tx: DbTx,
  billing: ReservationProjectionRow,
): Promise<void> {
  if (billing.channelId != null && billing.channelReservedAmount != null) {
    const channelReleased = await tx
      .update(channels)
      .set({
        upstreamReserved: sql`${channels.upstreamReserved} - ${billing.channelReservedAmount}::numeric`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        sql`${channels.id} = ${billing.channelId}
            and ${channels.upstreamReserved} >= ${billing.channelReservedAmount}::numeric`,
      )
      .returning({ id: channels.id });
    if (channelReleased.length === 0) throw new BillingInvariantError('channel_reservation_invariant');
  }
}

export async function deductChannelBudget(
  tx: DbTx,
  data: UsageReceipt,
  upstreamCost: string,
): Promise<boolean> {
  if (data.channelId == null) return false;
  const channelDeduct = await tx
    .update(channels)
    .set({
      upstreamBudget: sql`${channels.upstreamBudget} - ${upstreamCost}::numeric`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(channels.id, data.channelId))
    .returning({
      upstreamBudget: channels.upstreamBudget,
      upstreamThreshold: channels.upstreamThreshold,
    });
  if (channelDeduct.length > 0) {
    const threshold =
      channelDeduct[0]!.upstreamThreshold != null
        ? toDecimal(channelDeduct[0]!.upstreamThreshold)
        : new Decimal(0);
    if (toDecimal(channelDeduct[0]!.upstreamBudget).lte(threshold)) {
      await tx
        .update(channels)
        .set({ status: 3, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(channels.id, data.channelId), eq(channels.status, 0)));
      return true;
    }
  }
  return false;
}
