/**
 * 释放全部在途预扣（signal.failed 与将来 worker recover 共用的唯一实现）：
 * 明细行逐笔 source.release → markReleased → 渠道敞口归还。
 * 任何一处遗漏 = 永久冻结；任何一处守卫落空 = 投影脱节（红灯整体回滚）。
 */
import { BillingStateConflictError, Decimal } from '@ai-gateway/domain';
import type { DbTx, Repositories } from '@ai-gateway/repository';
import type { ChannelBudgetCloseout } from '../channel-budget/index.js';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import type { FundingRegistry } from './registry.js';

export interface ReleaseAllInput {
  requestId: string;
  /** 账单行记录的总预扣——与明细加总对不上即事实脱节（红灯） */
  reservedAmount: string;
  channelId: number | null;
  channelReservedAmount: string | null;
  now: Date;
}

export function createReleaseAllReservations(deps: {
  registry: FundingRegistry;
  channelBudget?: ChannelBudgetCloseout;
  repos: Repositories;
}) {
  return async function releaseAllReservations(
    ctx: RunContext,
    tx: DbTx,
    input: ReleaseAllInput,
  ): Promise<string> {
    const c = inTx(ctx, tx);
    // 账单已在同事务 CAS 成 released——查明细须把它并入白名单（默认只认在途）
    const actives = await deps.repos.billingReservation.findActive(c, input.requestId, [
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
      await source.release(c, {
        billingRequestId: active.billingRequestId,
        sourceType: active.sourceType,
        sourceRefId: active.sourceRefId,
        amount: active.amount,
      });
      if (!(await deps.repos.billingReservation.markReleased(c, active.id, input.now))) {
        throw new BillingStateConflictError(input.requestId, 'reservation already settled');
      }
      released = released.plus(active.amount);
    }
    if (!released.eq(input.reservedAmount)) {
      // 明细加总 ≠ 账单总预扣：真相表与投影脱节（零金额 0=0 除外）——确定性红灯
      throw new BillingStateConflictError(
        input.requestId,
        `reservation sum ${released.toString()} != reserved ${input.reservedAmount}`,
      );
    }

    await deps.channelBudget?.releaseExposure(ctx, tx, {
      channelId: input.channelId,
      channelReservedAmount: input.channelReservedAmount,
    });
    return released.toString();
  };
}
