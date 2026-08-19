/**
 * billing/release-reservations（S5 重写）：预扣释放的唯一实现——三路投影。
 *
 * 一个请求的预扣落在三处：wallet 冻结单（PAYG 部分，refType 'billing'）、
 * 订阅额度在途（plan 部分）、渠道在途敞口。释放必须三路同步，任何一处遗漏
 * 都会造成永久冻结（R1 教训）。
 * 消费方：signal(request.failed) / processor(recover) / dead(abandon)。
 * settle 的「释放 + 扣款」走 settle.ts 的合并语义，不经此处。
 */
import type { Wallet } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { releaseQuota } from '../subscription/quota.js';
import { releaseExposure } from '../channel-budget/closeout.js';
import { BillingInvariantError } from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';

export interface ReservationProjections {
  requestId: string;
  userId: number;
  reservedAmount: string;
  planReservedAmount: string | null;
  subscriptionId: number | null;
  channelId: number | null;
  channelReservedAmount: string | null;
}

export async function releaseReservations(
  wallet: Wallet,
  tx: DomainTx,
  row: ReservationProjections,
): Promise<void> {
  // PAYG 部分 = 总预扣 − 套餐部分：释放 wallet 冻结单
  const paygPart = toStorage(
    toDecimal(row.reservedAmount).minus(toDecimal(row.planReservedAmount ?? '0')),
  );
  if (toDecimal(paygPart).gt(0)) {
    const released = await wallet.release({
      refType: 'billing',
      refId: row.requestId,
      reason: 'billing_released',
      tx: tx as unknown as Parameters<Wallet['release']>[0]['tx'],
    });
    // wallet.release 对非 active 冻结幂等 no-op；但金额对不上即是事实脱节
    if (!toDecimal(released.amount).eq(paygPart)) {
      throw new BillingInvariantError('billing_reservation_invariant');
    }
  }
  // 套餐在途释放（若有）
  if (row.subscriptionId != null && toDecimal(row.planReservedAmount ?? '0').gt(0)) {
    await releaseQuota(tx, { subscriptionId: row.subscriptionId, reserved: row.planReservedAmount! });
  }
  // 渠道在途释放（若有）
  await releaseExposure(tx, {
    channelId: row.channelId,
    channelReservedAmount: row.channelReservedAmount,
  });
}
