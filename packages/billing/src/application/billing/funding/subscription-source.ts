/**
 * 订阅来源（先耗，priority 10）：凭证绑定的订阅额度。
 * probe = 查询编排（订阅快照/成员限额/花费口径）；闸门规则本体在 domain 的
 * subscriptionAvailability（结构性非法抛错 / 开关 OFF 整单拒绝 / ON 返回余量补差）。
 */
import { DefectError } from '@tillgate/errors';
import { subscriptionAvailability } from '../../../domain/billing/subscription-availability.js';
import { billingDayStart, billingMonthStart } from '../../../domain/billing/daily-window.js';
import { BillingErrors } from '../../../domain/errors.js';
import { Decimal } from '../../../domain/money.js';
import { overCollectCeiling } from './over-collect.js';
import { BILLING_REF_TYPE } from '../../wallet/authorize.js';
import type { BillingStore } from '../../../ports/billing-store.js';
import type { SubscriptionQuotaStore } from '../../../ports/funding-ports.js';
import type { WalletStore, WalletTx } from '../../../ports/wallet-store.js';
import type { WalletApi } from '../../wallet/wallet.js';
import type {
  FundingSource,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceSettleInput,
  SourceSettleResult,
} from './source.js';

// eslint-disable-next-line max-lines-per-function -- 订阅资金源生命周期动词(probe/reserve)事务体
export function createSubscriptionSource(deps: {
  quota: SubscriptionQuotaStore;
  billing: BillingStore;
  wallet: WalletApi;
  walletStore: WalletStore;
}): FundingSource {
  const type = 'subscription' as const;
  return {
    type,
    priority: 10,

    /** 仅套餐 Key 适用（凭证绑定订阅）；普通 Key 恒不消耗订阅额度 */
    applies: (context) => context.resolved.subscriptionId != null,

    // eslint-disable-next-line max-lines-per-function -- 订阅资金源生命周期动词(probe/reserve)事务体
    async probe(tx: WalletTx, input: ProbeInput): Promise<Decimal> {
      // applies 谓词保证 subscriptionId 已解析;守卫收窄替代非空断言
      const { subscriptionId } = input.context.resolved;
      if (subscriptionId === null) {
        throw new DefectError('subscription_source.no_subscription', 'billing.wallet_invariant');
      }
      const sub = await deps.quota.activeSubscriptionSnapshot(tx, subscriptionId, input.now);

      // 归属解析：owner 直通（无成员限额）；非 owner 查 org 成员限额与花费口径
      let membership: { dailySpendLimit: string | null; monthlyQuota: string | null } | null = null;
      let dailySpent: string | null = null;
      let monthlySpent: string | null = null;
      let exposure: string | null = null;
      if (sub != null && sub.userId !== input.userId && sub.orgId != null) {
        membership = await deps.quota.memberLimits(tx, { orgId: sub.orgId, userId: input.userId });
        if (membership) {
          exposure = await deps.billing.sumExposure(tx, {
            userId: input.userId,
            subscriptionId,
            excludeRequestId: input.requestId,
          });
          if (membership.dailySpendLimit != null) {
            dailySpent = await deps.billing.sumSettledSpend(tx, {
              userId: input.userId,
              subscriptionId,
              since: billingDayStart(input.now),
            });
          }
          if (membership.monthlyQuota != null) {
            monthlySpent = await deps.billing.sumSettledSpend(tx, {
              userId: input.userId,
              subscriptionId,
              // 月度窗口单一真相：与每日窗口同住 daily-window（避免独立 new Date(y,m,1)
              // 实现漂移——窗口错位 = 配额重置时刻互相矛盾）
              since: billingMonthStart(input.now),
            });
          }
        }
      }

      // 闸门规则（domain 纯函数）：结构性非法抛错 / 开关 OFF 整单拒绝 / ON 返回余量补差
      return subscriptionAvailability(
        {
          subscription: sub
            ? {
                ownerId: sub.userId,
                orgId: sub.orgId,
                quotaAmount: sub.quotaAmount,
                usedAmount: sub.usedAmount,
                reservedAmount: sub.reservedAmount,
              }
            : null,
          membership,
          dailySpent,
          monthlySpent,
          exposure,
        },
        {
          userId: input.userId,
          subscriptionId,
          amount: input.amount,
          allowPaygFallback: input.context.resolved.allowPaygFallback,
        },
      );
    },

    async reserve(tx: WalletTx, input: ReserveInput): Promise<SourceReservation> {
      const { subscriptionId } = input.context.resolved;
      if (subscriptionId === null) {
        throw new DefectError('subscription_source.no_subscription', 'billing.wallet_invariant');
      }
      const outcome = await deps.quota.tryReserveQuota(tx, {
        subscriptionId,
        amount: input.amount,
      });
      if (outcome === 'inactive') {
        throw BillingErrors.business('subscription_required', { userId: input.userId });
      }
      if (outcome === 'exhausted') {
        // 守卫输掉跨 user 并发（advisory 锁外唯一的竞态窗口）→ 调用方事务整体回滚
        throw BillingErrors.business('subscription_quota_exhausted', {
          userId: input.userId,
          remaining: '0',
          requested: input.amount,
        });
      }
      return {
        billingRequestId: input.requestId,
        sourceType: type,
        sourceRefId: subscriptionId,
        amount: input.amount,
      };
    },

    async release(tx: WalletTx, reservation: SourceReservation, amount?: string): Promise<void> {
      const { sourceRefId } = reservation;
      if (sourceRefId === null) {
        throw new DefectError('subscription_source.no_source_ref', 'billing.wallet_invariant');
      }
      const ok = await deps.quota.tryReleaseQuota(tx, {
        subscriptionId: sourceRefId,
        reserved: amount ?? reservation.amount,
      });
      if (!ok) {
        // 在途事实脱节（reserved 不足扣减）→ 红灯，调用方事务回滚
        throw BillingErrors.business('state_conflict', {
          requestId: reservation.billingRequestId,
          detail: 'quota release guard missed',
        });
      }
    },

    async settle(tx: WalletTx, input: SourceSettleInput): Promise<SourceSettleResult> {
      // 套餐只核销预留内份额；纯套餐链的超额转用户余额补扣——与 PAYG 同口径
      // 钳制到可收额（负余额与账本一致性触发器矛盾），差额 waived 上报。
      const { sourceRefId } = input.reservation;
      if (sourceRefId === null) {
        throw new DefectError('subscription_source.no_source_ref', 'billing.wallet_invariant');
      }
      const ok = await deps.quota.trySettleQuota(tx, {
        subscriptionId: sourceRefId,
        reserved: input.reservation.amount,
        consumed: input.consume,
      });
      if (!ok) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          detail: 'quota settle guard missed',
        });
      }
      const over = new Decimal(input.over);
      if (!over.gt(0)) return { waived: '0' };
      // 钳到可收额（可用 + 透支地板；见 over-collect.ts），差额 waived 上报
      const collectOver = Decimal.min(
        over,
        await overCollectCeiling(deps.walletStore, tx, input.userId),
      );
      if (collectOver.gt(0)) {
        await deps.wallet.authorize({
          userId: input.userId,
          amount: collectOver.toString(),
          refType: BILLING_REF_TYPE,
          refId: `${input.requestId}#over`,
          memo: `subscription overage ${input.requestId}`,
          collectOverage: true,
          tx,
        });
        await deps.wallet.settle({
          refType: BILLING_REF_TYPE,
          refId: `${input.requestId}#over`,
          amount: collectOver.toString(),
          memo: `subscription overage ${input.requestId}`,
          tx,
        });
      }
      return { waived: over.minus(collectOver).toString() };
    },
  };
}
