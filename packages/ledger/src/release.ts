import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { channels, users, userSubscriptions } from '@ai-gateway/db/schema';
import { toDecimal, toStorage } from '@ai-gateway/money';

/**
 * 预扣释放的唯一实现（组件化下沉）。
 *
 * 一个请求的预扣落在三个投影上：users.reserved_balance（余额在途，PAYG 部分）、
 * user_subscriptions.reserved_amount（套餐在途）、channels.upstream_reserved（渠道在途）。
 * 释放必须三处同步，任何一处遗漏都会造成永久冻结（R1 教训：signal 路径漏了余额部分）。
 *
 * 消费方（错误语义由各自注入，保持对外行为不变）：
 *   - billing-flow.signal(request.failed)：失败释放
 *   - billing-processor.recoverOnce：过期授权回收
 *   - billing-operations.releaseReservations：resolve/abandon 人工路径
 * settle 的「释放 + 扣款」是单条合并 UPDATE（不同语义），不走此处。
 */
export type ReleaseTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ReservationRow {
  userId: number;
  reservedAmount: string;
  planReservedAmount: string | null;
  subscriptionId: number | null;
  channelId: number | null;
  channelReservedAmount: string | null;
}

export async function releaseReservedAmounts(
  tx: ReleaseTx,
  row: ReservationRow,
  fail: (dimension: 'user' | 'subscription' | 'channel') => Error,
): Promise<void> {
  const planPart = row.planReservedAmount ?? '0';
  const paygPart = toStorage(toDecimal(row.reservedAmount).minus(toDecimal(planPart)));
  // 释放余额在途敞口（若有）：PAYG 部分 = 总预扣 − 套餐部分
  if (toDecimal(paygPart).gt(0)) {
    const reservation = await tx
      .update(users)
      .set({
        reservedBalance: sql`${users.reservedBalance} - ${paygPart}::numeric`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        sql`${users.id} = ${row.userId}
            and ${users.reservedBalance} >= ${paygPart}::numeric`,
      )
      .returning({ id: users.id });
    if (reservation.length === 0) throw fail('user');
  }
  // 释放套餐在途敞口（若有）
  if (row.subscriptionId != null && toDecimal(planPart).gt(0)) {
    const subReleased = await tx
      .update(userSubscriptions)
      .set({
        reservedAmount: sql`${userSubscriptions.reservedAmount} - ${planPart}::numeric`,
      })
      .where(
        sql`${userSubscriptions.id} = ${row.subscriptionId}
            and ${userSubscriptions.reservedAmount} >= ${planPart}::numeric`,
      )
      .returning({ id: userSubscriptions.id });
    if (subReleased.length === 0) throw fail('subscription');
  }
  // 释放渠道在途敞口（若有）
  if (
    row.channelId != null &&
    row.channelReservedAmount != null &&
    toDecimal(row.channelReservedAmount).gt(0)
  ) {
    const channelReleased = await tx
      .update(channels)
      .set({
        upstreamReserved: sql`${channels.upstreamReserved} - ${row.channelReservedAmount}::numeric`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        sql`${channels.id} = ${row.channelId}
            and ${channels.upstreamReserved} >= ${row.channelReservedAmount}::numeric`,
      )
      .returning({ id: channels.id });
    if (channelReleased.length === 0) throw fail('channel');
  }
}
