/**
 * channel-budget/closeout：结算收尾（S4，自 billing/settle/channel-closeout 上移，行为零变更）。
 *
 *   releaseExposure  结算前释放在途敞口（本请求预留的上游成本预估）
 *   deductBudget     结算后按真实上游成本扣减进货额度；余额 ≤ 阈值 → 熔断
 *                    status=3（渠道级软闸，worker 会 bump 路由缓存）
 */
import { and, eq, sql } from 'drizzle-orm';
import { Decimal, toDecimal } from '@ai-gateway/wallet/metering';
import { channels } from '@ai-gateway/db/schema';
import { BillingInvariantError } from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';

export interface ExposureProjection {
  channelId: number | null;
  channelReservedAmount: string | null;
}

export async function releaseExposure(
  tx: DomainTx,
  billing: ExposureProjection,
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

export async function deductBudget(
  tx: DomainTx,
  channelId: number | null,
  upstreamCost: string,
): Promise<boolean> {
  if (channelId == null) return false;
  const channelDeduct = await tx
    .update(channels)
    .set({
      upstreamBudget: sql`${channels.upstreamBudget} - ${upstreamCost}::numeric`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(channels.id, channelId))
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
        .where(and(eq(channels.id, channelId), eq(channels.status, 0)));
      return true;
    }
  }
  return false;
}
