/**
 * subscription/pack：加油包（transfer 现金口径 + 订阅额度累加，失效订阅竞态守卫）。
 * 行为规格迁移自旧 ledger.ts grantPack（S3）；资金实现换 wallet.transfer。
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { plans, userSubscriptions, users } from '@ai-gateway/db/schema';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { LedgerError } from '../platform/errors.js';
import { chargeCash, runSubscriptionAudit } from './purchase.js';
import type { PackInput, SubscribeResult, SubscriptionContext } from './types.js';

export async function grantPack(
  ctx: SubscriptionContext,
  input: PackInput,
): Promise<SubscribeResult> {
  const { receipt, replayed } = await ctx.operations.run({
    operationId: input.operationId,
    kind: 'pack.grant',
    fingerprint: { kind: 'pack.grant', userId: input.userId, packId: input.packId },
    execute: async (tx) => {
      const pack = await tx.query.plans.findFirst({
        where: eq(plans.id, input.packId),
        columns: { name: true, price: true, quotaAmount: true, status: true, kind: true },
      });
      if (!pack) throw new LedgerError('plan_not_found');
      if (pack.status !== 0) throw new LedgerError('plan_disabled');
      if (pack.kind !== 'pack') throw new LedgerError('not_a_pack');
      // R2 同款红线：零价加油包 = 免费额度印刷机；赠送场景走 promotions 域，不走商品目录
      if (toDecimal(pack.price).lte(0)) throw new LedgerError('plan_not_purchasable');

      const now = ctx.clock();
      const price = toStorage(toDecimal(pack.price));
      const quota = toStorage(toDecimal(pack.quotaAmount));

      // 加油包加的是「订阅额度」：必须有有效订阅。选行 FOR UPDATE——无锁读会与
      // 并发取消/变更竞态（读到 status=0 后该行被置 1），额度加到失效行 = 钱进死行。
      const subRows = await tx
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, input.userId),
            eq(userSubscriptions.status, 0),
            gt(userSubscriptions.endAt, now),
          ),
        )
        .for('update');
      const sub = subRows[0];
      if (!sub) throw new LedgerError('no_subscription');

      const userRow = await tx.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { id: true },
      });
      if (!userRow) throw new LedgerError('user_not_found');

      // 资金：现金口径收款（禁透支）
      const charge = await chargeCash(ctx, tx, {
        userId: input.userId,
        amount: price,
        refType: 'pack',
        refId: input.operationId,
        memo: `加油包「${pack.name}」到账额度 ${quota}（售价 ${price}）`,
      });

      // 额度 UPDATE 带 status=0 守卫并校验 returning——0 行命中说明订阅已被并发
      // 取消/替换，绝不能把额度加到失效行上（P1-3 不变量下沉）。
      const subUpdated = await tx
        .update(userSubscriptions)
        .set({ quotaAmount: sql`${userSubscriptions.quotaAmount} + ${quota}::numeric` })
        .where(and(eq(userSubscriptions.id, sub.id), eq(userSubscriptions.status, 0)))
        .returning({ id: userSubscriptions.id });
      if (subUpdated.length === 0) throw new LedgerError('subscription_inactive');

      return {
        userId: input.userId,
        subscriptionId: 0,
        orgId: null,
        planId: input.packId,
        planName: pack.name,
        quantity: 1,
        startAt: now.toISOString(),
        endAt: now.toISOString(),
        quotaAmount: quota,
        price,
        balanceBefore: charge.balanceBefore,
        balanceAfter: charge.balanceAfter,
      };
    },
  });

  await runSubscriptionAudit(ctx, !replayed, {
    adminId: input.adminId ?? null,
    action: 'pack.grant',
    targetType: 'pack',
    targetId: receipt.planId,
    detail: { userId: receipt.userId, quotaAmount: receipt.quotaAmount, price: receipt.price },
  });
  return { ...receipt, replayed };
}
