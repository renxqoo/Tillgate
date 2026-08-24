/**
 * reserveChannel 用例：渠道「进货额度」精确硬闸（路由选渠前预留在途上游成本敞口）。
 *
 * 变更顺序不变量（换渠道路径）：先守卫预留新渠道 → 再释放旧渠道 → 最后 CAS 认领账单行。
 * 任何早退（拒绝）都发生在零变更状态；CAS（channel 投影等于读到的旧值）让并发同请求
 * 双切换在结构上不可能产生孤儿敞口——输家 CAS 落空 → 整体回滚。
 * 同渠道重复预留：金额更大按差额补足（fallback 模型预估更高路由回同一渠道）。
 */
import { DefectError } from '@tillgate/errors';
import { BillingErrors } from '../../domain/errors.js';
import { budgetRemaining, reserveDecision } from '../../domain/billing/channel-exposure.js';
import { Decimal } from '../../domain/money.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';

export interface ReserveChannelInput {
  requestId: string;
  channelId: number;
  /** 本次上游成本预估（官方价口径，系数=1） */
  amount: string;
}

export interface ChannelReservationResult {
  allowed: boolean;
  /** 拒绝时的剩余可用额度；放行时为本次预留后剩余 */
  remaining: string;
  /** 是否为本请求切换了渠道（释放了旧渠道敞口） */
  switched: boolean;
}

// eslint-disable-next-line max-lines-per-function -- 渠道路由预算预扣编排:候选过滤→预扣→回执
export function createReserveChannelUseCase(env: {
  store: BillingStore;
  channels: ChannelExposureStore;
  /** 时钟（装配必填——零写死） */
  clock: () => Date;
}) {
  const { store, channels, clock } = env;
  // eslint-disable-next-line max-lines-per-function -- 渠道路由预算预扣编排:候选过滤→预扣→回执
  return async function reserveChannel(
    input: ReserveChannelInput,
  ): Promise<ChannelReservationResult> {
    const amount = new Decimal(input.amount);
    if (!amount.isFinite() || amount.lt(0)) {
      throw BillingErrors.business('state_conflict', {
        requestId: input.requestId,
        detail: 'invalid channel exposure amount',
      });
    }
    const now = clock();
    // eslint-disable-next-line max-lines-per-function -- 渠道路由预算预扣编排:候选过滤→预扣→回执
    return store.transaction(async (tx) => {
      const br = await store.findByRequestId(tx, input.requestId);
      if (!br) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          detail: 'billing request missing',
        });
      }
      if (!['authorized', 'in_flight'].includes(br.status)) {
        return { allowed: false, remaining: '0', switched: false };
      }

      // 决策（domain 纯函数）：covered / topup / switch 三模式
      const decision = reserveDecision({
        currentChannelId: br.channelId,
        currentReserved: br.channelReservedAmount,
        channelId: input.channelId,
        amount,
      });

      // 同渠道已覆盖：无需任何变更
      if (decision.mode === 'covered') {
        return { allowed: true, remaining: '0', switched: false };
      }
      // 同渠道补足（F3）：预估更高路由回同一渠道，敞口必须补差否则预算闸门被弱化
      if (decision.mode === 'topup') {
        const topped = await channels.tryIncreaseReserved(tx, {
          channelId: input.channelId,
          delta: decision.delta,
          now,
        });
        if (!topped) {
          const ch = await channels.findChannel(tx, input.channelId);
          return {
            allowed: false,
            remaining: ch ? budgetRemaining(ch.upstreamBudget, ch.upstreamReserved) : '0',
            switched: false,
          };
        }
        const claimed = await store.casClaimChannel(tx, {
          requestId: input.requestId,
          fromStatus: ['authorized', 'in_flight'],
          expectedChannelId: br.channelId,
          expectedReserved: br.channelReservedAmount,
          channelId: input.channelId,
          channelReservedAmount: amount.toString(),
          now,
        });
        if (!claimed) {
          throw BillingErrors.business('state_conflict', {
            requestId: input.requestId,
            detail: 'reserve target not reservable',
          });
        }
        return {
          allowed: true,
          remaining: budgetRemaining(topped.budget, topped.reserved),
          switched: false,
        };
      }

      // switch：守卫预留新渠道（原子 UPDATE WHERE 余额守卫；0 行 = 并发对手占走余额 → 零变更拒绝）
      const reserved = await channels.tryIncreaseReserved(tx, {
        channelId: input.channelId,
        delta: amount.toString(),
        now,
      });
      if (!reserved) {
        const ch = await channels.findChannel(tx, input.channelId);
        return {
          allowed: false,
          remaining: ch ? budgetRemaining(ch.upstreamBudget, ch.upstreamReserved) : '0',
          switched: false,
        };
      }

      // 换渠道：预留成功后才释放旧渠道敞口（守卫失败 → 抛错回滚新预留）
      let switched = false;
      if (br.channelId != null && br.channelReservedAmount != null) {
        const released = await channels.tryDecreaseReserved(tx, {
          channelId: br.channelId,
          amount: br.channelReservedAmount,
          now,
        });
        if (!released) {
          throw new DefectError(
            `switch release ${br.channelReservedAmount} on channel ${br.channelId}`,
            'billing.channel_exposure_invariant',
          );
        }
        switched = true;
      }

      // 认领账单行（最后一个变更）：与过期回收/并发同请求预留竞态时 0 行 → 整体回滚
      const claimed = await store.casClaimChannel(tx, {
        requestId: input.requestId,
        fromStatus: ['authorized', 'in_flight'],
        expectedChannelId: br.channelId,
        expectedReserved: br.channelReservedAmount,
        channelId: input.channelId,
        channelReservedAmount: amount.toString(),
        now,
      });
      if (!claimed) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          detail: 'reserve target not reservable',
        });
      }
      return {
        allowed: true,
        remaining: budgetRemaining(reserved.budget, reserved.reserved),
        switched,
      };
    });
  };
}
