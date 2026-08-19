/**
 * subscription/purchase：购买（与续费共用的资金+状态机核心）。
 *
 * 资金路径：wallet.transfer(user → platform_revenue, allowCredit:false, 同事务)
 * ——现金口径锁内守卫（禁透支购买），复式两端齐全；幂等键 = operationId。
 * 行为规格迁移自旧 ledger.ts applySubscription（S3），资金实现换 wallet。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import {
  apiKeys,
  apps,
  orgMembers,
  organizations,
  plans,
  userSubscriptions,
  users,
} from '@ai-gateway/db/schema';
import { REVENUE_ACCOUNT, type DbLike } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { LedgerError } from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';
import { periodEnd, renewalStart } from './period.js';
import type { SubscribeResult, SubscriptionContext } from './types.js';

/** 现金购买收款：user → platform_revenue（现金口径，禁透支）。 */
export async function chargeCash(
  ctx: SubscriptionContext,
  tx: DomainTx,
  input: { userId: number; amount: string; refType: 'subscription' | 'pack'; refId: string; memo?: string },
): Promise<{ balanceBefore: string; balanceAfter: string }> {
  const posted = await ctx.wallet.transfer({
    from: { userId: input.userId },
    to: { code: REVENUE_ACCOUNT },
    amount: input.amount,
    refType: input.refType,
    refId: input.refId,
    memo: input.memo,
    allowCredit: false,
    tx: tx as unknown as DbLike,
  });
  return {
    balanceBefore: toStorage(toDecimal(posted.fromBalanceAfter).plus(input.amount)),
    balanceAfter: posted.fromBalanceAfter,
  };
}

/** 购买/续费共用核心（kind 区分语义；指纹形状与旧版一致保重放兼容） */
export async function applySubscriptionCore(
  ctx: SubscriptionContext,
  input: {
    kind: 'subscription.purchase' | 'subscription.renew';
    operationId: string;
    userId: number | null;
    planId: number | null;
    subscriptionId: number | null;
    quantity: number | null;
    orgId: number | null;
    ensureOrg?: boolean;
    adminId: number | null;
  },
): Promise<SubscribeResult> {
  const { receipt, replayed } = await runWithSubscriptionRaceGuard(
    ctx.operations.run({
      operationId: input.operationId,
      kind: input.kind,
      fingerprint: {
        kind: input.kind,
        userId: input.userId,
        planId: input.planId,
        subscriptionId: input.subscriptionId,
        quantity: input.quantity,
        orgId: input.orgId,
      },
      execute: async (tx) => {
        const now = ctx.clock();
        let userId = input.userId;
        let planId = input.planId;
        let quantity = input.quantity ?? 1;
        let startAt = now;
        let renewOrgId: number | null = null;

        if (input.kind === 'subscription.renew') {
          // 只允许对有效订阅续费（已取消/已被替换的订阅不得复活）；org 随订阅继承。
          const sub = await tx.query.userSubscriptions.findFirst({
            where: and(
              eq(userSubscriptions.id, input.subscriptionId ?? 0),
              eq(userSubscriptions.status, 0),
            ),
            columns: { userId: true, planId: true, endAt: true, quantity: true, orgId: true },
          });
          if (!sub) throw new LedgerError('no_subscription');
          // 用户自助续费：校验归属（管理员不传 userId，不限归属）
          if (input.userId != null && sub.userId !== input.userId) {
            throw new LedgerError('no_subscription');
          }
          userId = sub.userId;
          planId = sub.planId;
          quantity = sub.quantity; // 续费沿用原席位
          renewOrgId = sub.orgId;
          startAt = renewalStart(sub.endAt, now);
          // 旧订阅转到期；0 行命中 = 状态已被并发改变，不得继续
          const expired = await tx
            .update(userSubscriptions)
            .set({ status: 1 })
            .where(
              and(
                eq(userSubscriptions.id, input.subscriptionId ?? 0),
                eq(userSubscriptions.status, 0),
              ),
            )
            .returning({ id: userSubscriptions.id });
          if (expired.length === 0) throw new LedgerError('no_subscription');
        } else {
          if (!Number.isInteger(quantity) || quantity < 1) {
            throw new LedgerError('invalid_quantity');
          }
          // C4：惰性翻转「已自然到期但 status 仍为 0」的订阅行——不翻则新购买撞
          // one_active_uq → already_subscribed，用户被死锁。
          await tx
            .update(userSubscriptions)
            .set({ status: 1 })
            .where(
              and(
                eq(userSubscriptions.userId, userId!),
                eq(userSubscriptions.status, 0),
                lte(userSubscriptions.endAt, now),
              ),
            );
          const active = await tx.query.userSubscriptions.findFirst({
            where: and(
              eq(userSubscriptions.userId, userId!),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, now),
            ),
            columns: { id: true },
          });
          if (active) throw new LedgerError('already_subscribed');
        }

        const userRow = await tx.query.users.findFirst({
          where: eq(users.id, userId!),
          columns: { isEnterprise: true },
        });
        if (!userRow) throw new LedgerError('user_not_found');

        const plan = await tx.query.plans.findFirst({
          where: eq(plans.id, planId ?? 0),
          columns: {
            name: true,
            price: true,
            periodDays: true,
            quotaAmount: true,
            status: true,
            kind: true,
            allowSeats: true,
          },
        });
        if (!plan) throw new LedgerError('plan_not_found');
        if (plan.status !== 0) throw new LedgerError('plan_disabled');
        // 自助购买闸门：上架套餐必须正价——零价套餐是免费额度印刷机（R2 资损红线）。
        if (toDecimal(plan.price).lte(0)) throw new LedgerError('plan_not_purchasable');
        if (plan.kind !== 'subscription') throw new LedgerError('not_a_pack');
        if (quantity > 1 && !plan.allowSeats) throw new LedgerError('seats_not_allowed');
        if (plan.allowSeats && !userRow.isEnterprise) throw new LedgerError('enterprise_required');

        // 团队套餐的组织在事务内创建（与订阅同生共死，重放不刷行）
        let orgId = input.orgId;
        if (input.ensureOrg && orgId == null && plan.allowSeats) {
          const [org] = await tx
            .insert(organizations)
            .values({ name: `组织-${randomUUID().slice(0, 6)}`, ownerUserId: userId! })
            .returning({ id: organizations.id });
          orgId = org!.id;
          await tx.insert(orgMembers).values({
            orgId: org!.id,
            userId: userId!,
            role: 'owner',
            status: 0,
          });
        }

        const endAt = periodEnd(startAt, Number(plan.periodDays));
        // 总价 = 档价 × 席位；总额度 = 档额度 × 席位（快照）
        const totalPrice = toDecimal(plan.price).times(quantity);
        const totalQuota = toDecimal(plan.quotaAmount).times(quantity);
        const price = toStorage(totalPrice);

        // 资金：现金口径收款（禁透支购买）；拒绝 = wallet InsufficientCashError（402 语义）
        const charge = await chargeCash(ctx, tx, {
          userId: userId!,
          amount: price,
          refType: 'subscription',
          refId: input.operationId,
          memo: `购买套餐「${plan.name}」×${quantity}`,
        });

        const [sub] = await tx
          .insert(userSubscriptions)
          .values({
            userId: userId!,
            planId: planId!,
            startAt,
            endAt,
            quotaAmount: toStorage(totalQuota),
            usedAmount: '0',
            reservedAmount: '0',
            quantity,
            price,
            orgId: input.kind === 'subscription.renew' ? renewOrgId : orgId,
            status: 0,
          })
          .returning({ id: userSubscriptions.id });

        // 续费：把绑定到旧订阅的凭证改绑到新订阅（续费不打断现有 key/app）。
        if (input.kind === 'subscription.renew' && input.subscriptionId != null) {
          await rebindCredentials(tx, input.subscriptionId, sub!.id);
        }

        return {
          userId: userId!,
          subscriptionId: sub!.id,
          orgId: input.kind === 'subscription.renew' ? renewOrgId : orgId,
          planId: planId!,
          planName: plan.name,
          quantity,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          quotaAmount: toStorage(totalQuota),
          price,
          balanceBefore: charge.balanceBefore,
          balanceAfter: charge.balanceAfter,
        };
      },
    }),
  );

  await runSubscriptionAudit(ctx, !replayed, {
    adminId: input.adminId,
    action: input.kind,
    targetType: 'subscription',
    targetId: receipt.subscriptionId,
    detail: { planId: receipt.planId, price: receipt.price },
  });
  return { ...receipt, replayed };
}

/** 凭证改绑（续费/升档同语义：付了钱后既有 Key/App 不应全员 402）。 */
export async function rebindCredentials(
  tx: DomainTx,
  oldSubscriptionId: number,
  newSubscriptionId: number,
): Promise<void> {
  await tx.update(apiKeys).set({ subscriptionId: newSubscriptionId }).where(eq(apiKeys.subscriptionId, oldSubscriptionId));
  await tx.update(apps).set({ subscriptionId: newSubscriptionId }).where(eq(apps.subscriptionId, oldSubscriptionId));
}

/** 「单有效订阅」唯一部分索引并发兜底：冲突 → already_subscribed（事务回滚，幂等键随事务回退可安全重试）。 */
async function runWithSubscriptionRaceGuard<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isOneActiveSubscriptionViolation(error)) throw new LedgerError('already_subscribed');
    throw error;
  }
}

function isOneActiveSubscriptionViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if ((current as { code?: string }).code === '23505') {
      const constraint = (current as { constraint?: string }).constraint;
      if (
        constraint === 'user_subscriptions_one_active_uq' ||
        constraint === 'user_subscriptions_one_org_uq'
      ) {
        return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 提交后审计（尽力而为；观测失败不改变已提交结果） */
export async function runSubscriptionAudit(
  ctx: SubscriptionContext,
  when: boolean,
  event: {
    adminId?: number | null;
    action: string;
    targetType: string;
    targetId?: number | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!when || !ctx.effects?.audit) return;
  try {
    await ctx.effects.audit(event);
  } catch {
    // PostgreSQL 已提交；临时副作用失败不能改变资金结果。
  }
}
