/**
 * 订阅来源（先耗，priority 10）：凭证绑定的订阅额度。
 * probe = 查询编排（订阅快照/成员限额/花费口径）；闸门规则本体在 domain 的
 * subscriptionAvailability（结构性非法抛错 / 开关 OFF 整单拒绝 / ON 返回余量补差）。
 */
import {
  billingDayStart,
  BillingStateConflictError,
  Decimal,
  subscriptionAvailability,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '@ai-gateway/domain';
import type { RepoContext, Repositories } from '@ai-gateway/repository';
import type {
  FundingSource,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceSettleInput,
} from './source.js';

export function createSubscriptionSource(deps: { repos: Repositories }): FundingSource {
  const type = 'subscription' as const;
  return {
    type,
    priority: 10,

    /** 仅套餐 Key 适用（凭证绑定订阅）；普通 Key 恒不消耗订阅额度 */
    applies: (context) => context.resolved.subscriptionId != null,

    async probe(c: RepoContext, input: ProbeInput): Promise<Decimal> {
      const { repos } = deps;
      const subscriptionId = input.context.resolved.subscriptionId!;
      const sub = await repos.subscription.activeSubscriptionSnapshot(c, subscriptionId, input.now);

      // 归属解析：owner 直通（无成员限额）；非 owner 查 org 成员限额与花费口径
      let membership: { dailySpendLimit: string | null; monthlyQuota: string | null } | null = null;
      let dailySpent: string | null = null;
      let monthlySpent: string | null = null;
      let exposure: string | null = null;
      if (sub != null && sub.userId !== input.userId && sub.orgId != null) {
        membership = await repos.orgMember.memberLimits(c, { orgId: sub.orgId, userId: input.userId });
        if (membership) {
          exposure = await repos.billingRequest.sumExposure(c, {
            userId: input.userId,
            subscriptionId,
            excludeRequestId: input.requestId,
          });
          if (membership.dailySpendLimit != null) {
            dailySpent = await repos.usageLog.sumSettledSpend(c, {
              userId: input.userId,
              subscriptionId,
              since: billingDayStart(input.now),
            });
          }
          if (membership.monthlyQuota != null) {
            monthlySpent = await repos.usageLog.sumSettledSpend(c, {
              userId: input.userId,
              subscriptionId,
              since: new Date(input.now.getFullYear(), input.now.getMonth(), 1),
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

    async reserve(c: RepoContext, input: ReserveInput): Promise<SourceReservation> {
      const subscriptionId = input.context.resolved.subscriptionId!;
      const outcome = await deps.repos.subscription.tryReserveQuota(c, {
        subscriptionId,
        amount: input.amount,
      });
      if (outcome === 'inactive') throw new SubscriptionRequiredError(input.userId);
      if (outcome === 'exhausted') {
        // 守卫输掉跨 user 并发（advisory 锁外唯一的竞态窗口）→ 调用方事务整体回滚
        throw new SubscriptionQuotaExhaustedError(input.userId, '0', input.amount);
      }
      return {
        billingRequestId: input.requestId,
        sourceType: type,
        sourceRefId: subscriptionId,
        amount: input.amount,
      };
    },

    async release(
      c: RepoContext,
      reservation: SourceReservation,
      amount?: string,
    ): Promise<void> {
      const ok = await deps.repos.subscription.tryReleaseQuota(c, {
        subscriptionId: reservation.sourceRefId!,
        reserved: amount ?? reservation.amount,
      });
      if (!ok) {
        // 在途事实脱节（reserved 不足扣减）→ 红灯，调用方事务回滚
        throw new BillingStateConflictError(
          reservation.billingRequestId,
          'quota release guard missed',
        );
      }
    },

    async settle(c: RepoContext, input: SourceSettleInput): Promise<void> {
      // 额度池无 hold 概念：核销额可超预留（over 已由分配规则并入/单独表达）；
      // 守卫 = 在途足额核销 + 核销后不超总额度
      const consumed = new Decimal(input.consume).plus(input.over).toString();
      const ok = await deps.repos.subscription.trySettleQuota(c, {
        subscriptionId: input.reservation.sourceRefId!,
        reserved: input.reservation.amount,
        consumed,
      });
      if (ok) return;
      // 超池降级（PAYG「收满预留」D3 的订阅对称）：实际用量可超预扣上界
      // （未声明 max_tokens 的请求不注入输出钳制、上游 usage 与估算口径差），
      // 池容量不足时核销到剩余容量、差额记损——冲突异常不属死信家族，
      // 原路径 10 轮重试全败 → dead + 预扣冻结。预占脱节仍抛真红灯。
      const bounded = await deps.repos.subscription.settleQuotaBounded(c, {
        subscriptionId: input.reservation.sourceRefId!,
        reserved: input.reservation.amount,
        consumed,
      });
      if (!bounded) {
        throw new BillingStateConflictError(input.requestId, 'quota settle guard missed');
      }
      const effective = new Decimal(bounded.usedAfter).minus(bounded.usedBefore);
      const shortfall = new Decimal(consumed).minus(effective);
      if (shortfall.gt(0)) {
        console.warn(
          `[subscription] over-quota degrade request=${input.requestId} ` +
            `consumed=${consumed} effective=${effective.toString()} ` +
            `loss=${shortfall.toString()} (bounded loss, no dead letter)`,
        );
      }
    },
  };
}
