/**
 * subscription/change：升档变更（proration 折算 → 现金补差价 → 新订阅行 + 凭证改绑）。
 * 行为规格迁移自旧 ledger.ts changeSubscription（S3）；资金实现换 wallet.transfer。
 */
import { and, eq, gt } from 'drizzle-orm';
import { plans, userSubscriptions, users } from '@ai-gateway/db/schema';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { LedgerError } from '../platform/errors.js';
import { assertChangeEligibility, assertSeatsAllowed } from './eligibility.js';
import { changeDiff, remainingValue } from './proration.js';
import { periodEnd } from './period.js';
import { chargeCash, rebindCredentials, runSubscriptionAudit } from './purchase.js';
import type { ChangeInput, SubscribeResult, SubscriptionContext } from './types.js';

export async function changeSubscription(
  ctx: SubscriptionContext,
  input: ChangeInput,
): Promise<SubscribeResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new LedgerError('invalid_quantity');
  }
  const now = ctx.clock();
  const { receipt, replayed } = await ctx.operations.run({
    operationId: input.operationId,
    kind: 'subscription.change',
    // 指纹含发起者：跨用户同键重放必须是冲突（409），不是把别人的余额快照回给攻击者。
    fingerprint: {
      kind: 'subscription.change',
      userId: input.userId ?? null,
      adminId: input.adminId ?? null,
      subscriptionId: input.subscriptionId,
      targetPlanId: input.targetPlanId,
      quantity: input.quantity,
    },
    execute: async (tx) => {
      // F2：折算价必须基于「拿到行锁后的新鲜快照」——无锁读会和并发结算/释放
      // 竞态 → 剩余价值被低估 → 升级补差价多收。
      const currentRows = await tx
        .select({
          userId: userSubscriptions.userId,
          planId: userSubscriptions.planId,
          orgId: userSubscriptions.orgId,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
          quantity: userSubscriptions.quantity,
          price: userSubscriptions.price,
        })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.id, input.subscriptionId),
            eq(userSubscriptions.status, 0),
            gt(userSubscriptions.endAt, now),
          ),
        )
        .for('update');
      const current = currentRows[0];
      if (!current) throw new LedgerError('no_subscription');
      if (input.userId != null && current.userId !== input.userId) {
        throw new LedgerError('no_subscription');
      }
      // plan 元数据（层级/名称）不受订阅行竞态影响，单独无锁读
      const currentPlan = await tx.query.plans.findFirst({
        where: eq(plans.id, current.planId),
        columns: { sortOrder: true, name: true },
      });

      const target = await tx.query.plans.findFirst({
        where: eq(plans.id, input.targetPlanId),
        columns: {
          name: true,
          price: true,
          periodDays: true,
          quotaAmount: true,
          status: true,
          kind: true,
          sortOrder: true,
          allowSeats: true,
        },
      });
      if (!target) throw new LedgerError('plan_not_found');
      if (target.status !== 0) throw new LedgerError('plan_disabled');
      if (toDecimal(target.price).lte(0)) throw new LedgerError('plan_not_purchasable');
      if (target.kind !== 'subscription') throw new LedgerError('not_a_pack');

      assertChangeEligibility({
        currentSortOrder: currentPlan?.sortOrder ?? null,
        targetSortOrder: target.sortOrder ?? null,
        currentQuantity: current.quantity,
        targetQuantity: input.quantity,
      });
      if (input.quantity > 1 || target.allowSeats) {
        const userRow = await tx.query.users.findFirst({
          where: eq(users.id, current.userId),
          columns: { isEnterprise: true },
        });
        if (!userRow) throw new LedgerError('user_not_found');
        assertSeatsAllowed({
          quantity: input.quantity,
          allowSeats: target.allowSeats,
          isEnterprise: userRow.isEnterprise,
        });
      }

      // 补差价 = max(0, 新总价 − 剩余价值)；≤0 免费升级
      const newTotalPrice = toDecimal(target.price).times(input.quantity);
      const diff = changeDiff(toStorage(newTotalPrice), remainingValue(current));

      // 旧订阅转到期（保留 used/reserved，供在途请求结算）；
      // 0 行命中 = 状态已被并发改变，继续按剩余价值抵扣等于给已作废额度退钱 → 拒绝
      const expired = await tx
        .update(userSubscriptions)
        .set({ status: 1 })
        .where(
          and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)),
        )
        .returning({ id: userSubscriptions.id });
      if (expired.length === 0) throw new LedgerError('no_subscription');

      // 资金：仅正差价收款（现金口径）；免费升级不产生资金变动（余额快照 null）
      let balanceBefore: string | null = null;
      let balanceAfter: string | null = null;
      if (diff.gt(0)) {
        const charge = await chargeCash(ctx, tx, {
          userId: current.userId,
          amount: toStorage(diff),
          refType: 'subscription',
          refId: input.operationId,
          memo: `变更套餐「${currentPlan?.name ?? `#${current.planId}`}」→「${target.name}」×${input.quantity} 补差价 ${toStorage(diff)}`,
        });
        balanceBefore = charge.balanceBefore;
        balanceAfter = charge.balanceAfter;
      }

      const endAt = periodEnd(now, Number(target.periodDays));
      const totalQuota = toDecimal(target.quotaAmount).times(input.quantity);
      const [sub] = await tx
        .insert(userSubscriptions)
        .values({
          userId: current.userId,
          planId: input.targetPlanId,
          startAt: now,
          endAt,
          quotaAmount: toStorage(totalQuota),
          usedAmount: '0',
          reservedAmount: '0',
          quantity: input.quantity,
          price: toStorage(newTotalPrice),
          // 组织归属随订阅继承（升档不得把组织订阅变个人订阅）
          orgId: current.orgId,
          status: 0,
        })
        .returning({ id: userSubscriptions.id });

      await rebindCredentials(tx, input.subscriptionId, sub!.id);

      return {
        userId: current.userId,
        subscriptionId: sub!.id,
        orgId: current.orgId,
        planId: input.targetPlanId,
        planName: target.name,
        quantity: input.quantity,
        startAt: now.toISOString(),
        endAt: endAt.toISOString(),
        quotaAmount: toStorage(totalQuota),
        price: toStorage(newTotalPrice),
        balanceBefore,
        balanceAfter,
      };
    },
  });

  await runSubscriptionAudit(ctx, !replayed, {
    adminId: input.adminId ?? null,
    action: 'subscription.change',
    targetType: 'subscription',
    targetId: receipt.subscriptionId,
    detail: { planId: receipt.planId, quantity: receipt.quantity, price: receipt.price },
  });
  return { ...receipt, replayed };
}
