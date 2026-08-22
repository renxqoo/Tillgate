/**
 * 订阅生命周期用例族（资金走 wallet 复式账本）：
 *
 *   purchase：余额现金购买（禁透支）→ 订阅行（团队套餐组织同事务创建）
 *   renew   ：顺延续费（旧订阅 CAS 转到期 + 新行 + 凭证改绑）
 *   change  ：升档/加席位（行锁新鲜快照折算 → 补差价 max(0, 新总价−剩余价值)）
 *   cancel  ：CAS 0→2，无资金变动——剩余额度作废（不退款）
 *   grantPack：有效订阅加额（现金口径 transfer，禁透支）
 *
 * 幂等：operations 用例（operationId + 指纹——同键同参重放回执，异参 409）。
 * 资金：wallet.transfer(user → platform_revenue, allowCredit:false, 同事务)。
 * 竞态：「单有效订阅」部分唯一索引兜底 → already_subscribed（事务回滚可安全重试）。
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import { REVENUE_ACCOUNT } from '../../domain/wallet/accounts.js';
import {
  assertChangeEligibility,
  assertSeatsAllowed,
  assertValidQuantity,
  changeDiff,
  periodEnd,
  remainingValue,
  renewalStart,
} from '../../domain/subscription/rules.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { AccountContextStore } from '../../ports/account-context.js';
import type { WalletTx } from '../../ports/wallet-store.js';
import { createOperationsUseCase } from '../operations.js';
import type { WalletApi } from '../wallet/wallet.js';

export interface SubscriptionsEnv {
  store: BillingStore;
  accounts: AccountContextStore;
  /** 资金动词（本域只花 transfer：现金收款） */
  wallet: Pick<WalletApi, 'transfer'>;
  clock?: () => Date;
}

export interface SubscribeResult {
  userId: number;
  subscriptionId: number;
  orgId: number | null;
  planId: number;
  planName: string;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  price: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  replayed: boolean;
}

export interface PurchaseInput {
  operationId: string;
  userId: number;
  planId: number;
  quantity?: number;
  /** 团队套餐：组织在购买事务内创建（与订阅共生死——预建会留孤儿 org） */
  ensureOrg?: boolean;
}

export interface RenewInput {
  operationId: string;
  /** null = 管理面（按 subscriptionId 直续，免属主检查） */
  userId: number | null;
  subscriptionId: number;
}

export interface ChangeInput {
  operationId: string;
  /** null = 管理面（免属主检查；指纹仍含发起者防跨键重放） */
  userId: number | null;
  subscriptionId: number;
  targetPlanId: number;
  quantity: number;
}

export interface CancelInput {
  operationId: string;
  subscriptionId: number;
}

export interface GrantPackInput {
  operationId: string;
  userId: number;
  packId: number;
}

export interface GrantPackResult {
  userId: number;
  subscriptionId: number;
  quotaAdded: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export interface SubscriptionsApi {
  purchase(input: PurchaseInput): Promise<SubscribeResult>;
  renew(input: RenewInput): Promise<SubscribeResult>;
  change(input: ChangeInput): Promise<SubscribeResult>;
  cancel(input: CancelInput): Promise<{ subscriptionId: number; replayed: boolean }>;
  grantPack(input: GrantPackInput): Promise<GrantPackResult>;
}

/** 现金收款：user → platform_revenue（allowCredit:false——禁透支购买） */
async function chargeCash(
  wallet: SubscriptionsEnv['wallet'],
  tx: WalletTx,
  input: {
    userId: number;
    amount: string;
    refId: string;
    memo: string;
    refType?: 'subscription' | 'pack';
  },
): Promise<{ balanceBefore: string; balanceAfter: string }> {
  const posted = await wallet.transfer({
    from: { userId: input.userId },
    to: { code: REVENUE_ACCOUNT },
    amount: input.amount,
    refType: input.refType ?? 'subscription',
    refId: input.refId,
    memo: input.memo,
    allowCredit: false,
    tx,
  });
  return {
    balanceBefore: new Decimal(posted.fromBalanceAfter).plus(input.amount).toString(),
    balanceAfter: posted.fromBalanceAfter,
  };
}

/** 「单有效订阅」唯一索引并发兜底（cause 链上找约束名） */
function isOneActiveViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const e = current as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === '23505') {
      if (
        e.constraint === 'user_subscriptions_one_active_uq' ||
        e.constraint === 'user_subscriptions_one_org_uq'
      ) {
        return true;
      }
    }
    current = e.cause;
  }
  return false;
}

export function createSubscriptionsApi(env: SubscriptionsEnv): SubscriptionsApi {
  const { store, accounts, wallet } = env;
  const clock = env.clock ?? (() => new Date());
  const operations = createOperationsUseCase({ store });

  /** 套餐闸门（购买/变更共用）：存在/上架/正价/订阅型 + 席位能力 */
  async function assertPlanPurchasable(
    tx: WalletTx,
    planId: number,
    userId: number,
    quantity: number,
  ) {
    const plan = await store.findPlan(tx, planId);
    if (!plan) throw BillingErrors.business('plan_not_found', { planId });
    if (plan.status !== 0) throw BillingErrors.business('plan_disabled', { planId });
    // 自助购买闸门：上架套餐必须正价——零价套餐是免费额度印刷机（资损红线）
    if (new Decimal(plan.price).lte(0)) {
      throw BillingErrors.business('plan_not_purchasable', { planId });
    }
    if (plan.kind !== 'subscription') throw BillingErrors.business('not_a_pack', { planId });
    if (quantity > 1 || plan.allowSeats) {
      const isEnterprise = await accounts.isEnterprise(tx, userId);
      assertSeatsAllowed({ quantity, allowSeats: plan.allowSeats, isEnterprise });
    }
    return plan;
  }

  async function purchaseOrRenew(
    kind: 'subscription.purchase' | 'subscription.renew',
    input: PurchaseInput | RenewInput,
  ): Promise<SubscribeResult> {
    const isRenew = kind === 'subscription.renew';
    try {
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind,
        payload: isRenew
          ? {
              userId: input.userId,
              subscriptionId: (input as RenewInput).subscriptionId,
            }
          : {
              userId: input.userId,
              planId: (input as PurchaseInput).planId,
              quantity: (input as PurchaseInput).quantity ?? 1,
            },
        execute: async (tx) => {
          const now = clock();
          let userId: number;
          let planId: number;
          let quantity: number;
          let startAt: Date;
          let renewOrgId: number | null = null;

          if (isRenew) {
            const { subscriptionId } = input as RenewInput;
            const sub = await store.lockActiveSubscription(tx, subscriptionId);
            if (!sub || (input.userId != null && sub.userId !== input.userId)) {
              throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
            }
            userId = sub.userId;
            planId = sub.planId;
            quantity = sub.quantity; // 续费沿用原席位
            renewOrgId = sub.orgId;
            startAt = renewalStart(sub.endAt, now);
            // 旧订阅转到期；0 行 = 状态已被并发改变，不得复活
            if (!(await store.casSubscriptionStatus(tx, { subscriptionId, from: 0, to: 1 }))) {
              throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
            }
          } else {
            const purchase = input as PurchaseInput;
            userId = purchase.userId;
            quantity = purchase.quantity ?? 1;
            assertValidQuantity(quantity);
            // C4：惰性翻转「已自然到期但 status 仍 0」——不翻则新购买撞唯一索引死锁
            await store.expireLapsedSubscriptions(tx, userId, now);
            const active = await store.lockActiveSubscriptionForUser(tx, userId, now);
            if (active) {
              throw BillingErrors.business('subscription_state', { reason: 'already_subscribed' });
            }
            planId = purchase.planId;
            startAt = now;
          }

          if (!(await accounts.userExists(tx, userId))) {
            throw BillingErrors.business('user_not_found', { userId });
          }
          const plan = await assertPlanPurchasable(tx, planId, userId, quantity);

          // 团队套餐的组织在事务内创建（重放不刷行——operations 占位先行）
          let orgId = renewOrgId;
          const purchaseInput = !isRenew ? (input as PurchaseInput) : null;
          if (purchaseInput?.ensureOrg && plan.allowSeats) {
            orgId = await accounts.insertOrgWithOwner(tx, {
              name: `组织-${randomUUID().slice(0, 6)}`,
              ownerUserId: userId,
            });
          }

          const endAt = periodEnd(startAt, plan.periodDays);
          // 总价 = 档价 × 席位；总额度 = 档额度 × 席位（快照）
          const price = new Decimal(plan.price).times(quantity).toString();
          const quotaAmount = new Decimal(plan.quotaAmount).times(quantity).toString();

          const charge = await chargeCash(wallet, tx, {
            userId,
            amount: price,
            refId: input.operationId,
            memo: `${isRenew ? '续费' : '购买'}套餐「${plan.name}」×${quantity}`,
          });

          const subscriptionId = await store.insertSubscription(tx, {
            userId,
            planId,
            startAt,
            endAt,
            quotaAmount,
            quantity,
            price,
            orgId,
          });

          // 续费：绑定旧订阅的凭证改绑到新订阅（续费不打断现有 key/app）
          if (isRenew) {
            await accounts.rebindCredentials(
              tx,
              (input as RenewInput).subscriptionId,
              subscriptionId,
            );
          }

          return {
            userId,
            subscriptionId,
            orgId,
            planId,
            planName: plan.name,
            quantity,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            quotaAmount,
            price,
            balanceBefore: charge.balanceBefore,
            balanceAfter: charge.balanceAfter,
          };
        },
      });
      return { ...receipt, replayed };
    } catch (error) {
      if (isOneActiveViolation(error)) {
        throw BillingErrors.business('subscription_state', { reason: 'already_subscribed' });
      }
      throw error;
    }
  }

  return {
    purchase: (input) => purchaseOrRenew('subscription.purchase', input),
    renew: (input) => purchaseOrRenew('subscription.renew', input),

    async change(input) {
      assertValidQuantity(input.quantity);
      try {
        const { receipt, replayed } = await operations.run({
          operationId: input.operationId,
          kind: 'subscription.change',
          payload: {
            userId: input.userId,
            subscriptionId: input.subscriptionId,
            targetPlanId: input.targetPlanId,
            quantity: input.quantity,
          },
          execute: async (tx) => {
            const now = clock();
            // F2：折算必须基于行锁后的新鲜快照——无锁读与并发结算竞态会低估剩余价值 → 多收
            const current = await store.lockActiveSubscription(tx, input.subscriptionId);
            if (!current || (input.userId != null && current.userId !== input.userId)) {
              throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
            }
            const currentPlan = await store.findPlan(tx, current.planId);
            const target = await assertPlanPurchasable(
              tx,
              input.targetPlanId,
              current.userId,
              input.quantity,
            );

            assertChangeEligibility({
              currentSortOrder: currentPlan?.sortOrder ?? null,
              targetSortOrder: target.sortOrder,
              currentQuantity: current.quantity,
              targetQuantity: input.quantity,
            });

            // 补差价 = max(0, 新总价 − 剩余价值)；≤0 免费升级
            const newTotalPrice = new Decimal(target.price).times(input.quantity);
            const diff = changeDiff(newTotalPrice.toString(), remainingValue(current));

            // 旧订阅转到期（保留 used/reserved 供在途请求结算）；0 行 = 并发已改 → 拒绝
            if (
              !(await store.casSubscriptionStatus(tx, {
                subscriptionId: input.subscriptionId,
                from: 0,
                to: 1,
              }))
            ) {
              throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
            }

            // 仅正差价收款；免费升级无资金变动
            let balanceBefore: string | null = null;
            let balanceAfter: string | null = null;
            if (diff.gt(0)) {
              const charge = await chargeCash(wallet, tx, {
                userId: current.userId,
                amount: diff.toString(),
                refId: input.operationId,
                memo: `变更套餐「${currentPlan?.name ?? `#${current.planId}`}」→「${target.name}」×${input.quantity} 补差价 ${diff.toString()}`,
              });
              balanceBefore = charge.balanceBefore;
              balanceAfter = charge.balanceAfter;
            }

            const endAt = periodEnd(now, target.periodDays);
            const quotaAmount = new Decimal(target.quotaAmount).times(input.quantity).toString();
            const subscriptionId = await store.insertSubscription(tx, {
              userId: current.userId,
              planId: input.targetPlanId,
              startAt: now,
              endAt,
              quotaAmount,
              quantity: input.quantity,
              price: newTotalPrice.toString(),
              // 组织归属随订阅继承（升档不得把组织订阅变个人订阅）
              orgId: current.orgId,
            });
            await accounts.rebindCredentials(tx, input.subscriptionId, subscriptionId);

            return {
              userId: current.userId,
              subscriptionId,
              orgId: current.orgId,
              planId: input.targetPlanId,
              planName: target.name,
              quantity: input.quantity,
              startAt: now.toISOString(),
              endAt: endAt.toISOString(),
              quotaAmount,
              price: newTotalPrice.toString(),
              balanceBefore,
              balanceAfter,
            };
          },
        });
        return { ...receipt, replayed };
      } catch (error) {
        if (isOneActiveViolation(error)) {
          throw BillingErrors.business('subscription_state', { reason: 'already_subscribed' });
        }
        throw error;
      }
    },

    async cancel(input) {
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind: 'subscription.cancel',
        payload: { subscriptionId: input.subscriptionId },
        execute: async (tx) => {
          // 仅有效订阅可取消；0 行 = 不存在/已到期/已取消（幂等重放走 operations 回执）
          const cancelled = await store.casSubscriptionStatus(tx, {
            subscriptionId: input.subscriptionId,
            from: 0,
            to: 2,
          });
          if (!cancelled) {
            throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
          }
          return { subscriptionId: input.subscriptionId };
        },
      });
      return { subscriptionId: receipt.subscriptionId, replayed };
    },

    async grantPack(input) {
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind: 'pack.grant',
        payload: { userId: input.userId, packId: input.packId },
        execute: async (tx) => {
          const now = clock();
          // 加油包挂靠有效订阅（行锁）；无有效订阅 → no_subscription
          const sub = await store.lockActiveSubscriptionForUser(tx, input.userId, now);
          if (!sub) {
            throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
          }
          const pack = await store.findPlan(tx, input.packId);
          if (!pack) throw BillingErrors.business('plan_not_found', { planId: input.packId });
          if (pack.status !== 0)
            throw BillingErrors.business('plan_disabled', { planId: input.packId });
          if (pack.kind !== 'pack')
            throw BillingErrors.business('not_a_pack', { planId: input.packId });
          // 零价加油包是免费额度印刷机（资损红线）——发放必须走现金口径
          if (new Decimal(pack.price).lte(0)) {
            throw BillingErrors.business('plan_not_purchasable', { planId: input.packId });
          }

          const charge = await chargeCash(wallet, tx, {
            userId: input.userId,
            amount: pack.price,
            refId: input.operationId,
            memo: `加油包「${pack.name}」发放`,
            refType: 'pack',
          });
          // 配额加到当前有效订阅（status=0 守卫）；0 行 = 并发取消 → 冲突拒绝
          const added = await store.tryAddQuota(tx, {
            subscriptionId: sub.id,
            quota: pack.quotaAmount,
          });
          if (!added) {
            throw BillingErrors.business('subscription_state', { reason: 'subscription_inactive' });
          }

          return {
            userId: input.userId,
            subscriptionId: sub.id,
            quotaAdded: pack.quotaAmount,
            balanceBefore: charge.balanceBefore,
            balanceAfter: charge.balanceAfter,
          };
        },
      });
      return { ...receipt, replayed };
    },
  };
}
