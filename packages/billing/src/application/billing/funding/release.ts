/**
 * 释放全部在途预扣（signal.failed 与结算恢复共用的唯一实现）：
 * 明细行逐笔 source.release → markReleased → 渠道敞口归还。
 * 任何一处遗漏 = 永久冻结；任何一处守卫落空 = 投影脱节（红灯整体回滚）。
 */
import { BillingErrors } from '../../../domain/errors.js';
import { Decimal } from '../../../domain/money.js';
import { DefectError } from '@tillgate/errors';
import type { BillingStore } from '../../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../../ports/funding-ports.js';
import type { WalletTx } from '../../../ports/wallet-store.js';
import type { FundingRegistry } from './registry.js';

export interface ReleaseAllInput {
  requestId: string;
  /** 账单行记录的总预扣——与明细加总对不上即事实脱节（红灯） */
  reservedAmount: string;
  channelId: number | null;
  channelReservedAmount: string | null;
  now: Date;
}

// eslint-disable-next-line max-lines-per-function -- funding 源生命周期动词事务体
export function createReleaseAllReservations(deps: {
  registry: FundingRegistry;
  channels?: ChannelExposureStore;
  store: BillingStore;
}) {
  // eslint-disable-next-line max-lines-per-function -- funding 源生命周期动词事务体
  return async function releaseAllReservations(
    tx: WalletTx,
    input: ReleaseAllInput,
  ): Promise<string> {
    // 账单已在同事务 CAS 成 released——查明细须把它并入白名单（默认只认在途）
    const actives = await deps.store.findActiveReservations(tx, input.requestId, [
      'authorized',
      'in_flight',
      'settlement_pending',
      'processing',
      'retry_wait',
      'dead',
      'released',
    ]);

    let released = new Decimal(0);
    for (const active of actives) {
      const source = deps.registry.get(active.sourceType);
      await source.release(tx, {
        billingRequestId: active.billingRequestId,
        sourceType: active.sourceType,
        sourceRefId: active.sourceRefId,
        amount: active.amount,
      });
      if (!(await deps.store.markReservationReleased(tx, active.id, input.now))) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          detail: 'reservation already settled',
        });
      }
      released = released.plus(active.amount);
    }
    if (!released.eq(input.reservedAmount)) {
      // 明细加总 ≠ 账单总预扣：真相表与投影脱节——确定性红灯
      throw new DefectError(
        `reservation sum ${released.toString()} != reserved ${input.reservedAmount}`,
        'billing.billing_invariant',
      );
    }

    if (input.channelId != null && input.channelReservedAmount != null) {
      const returned = await deps.channels?.tryDecreaseReserved(tx, {
        channelId: input.channelId,
        amount: input.channelReservedAmount,
        now: input.now,
      });
      if (deps.channels && !returned) {
        throw new DefectError(
          `release ${input.channelReservedAmount} on channel ${input.channelId}`,
          'billing.channel_exposure_invariant',
        );
      }
    }
    return released.toString();
  };
}
