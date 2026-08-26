/**
 * 订阅动词共享件（一动词一文件拆分的跨动词复用层）：
 *   - 装配对象：env 显式展开 + 幂等 operations 用例单例（无跨请求状态，纯闭包）
 *   - chargeCash：现金收款（user → platform_revenue，allowCredit:false 禁透支）
 *   - assertPlanPurchasable：套餐闸门（购买/续费/变更共用）
 *   - snapshotPlanForQuantity：配额快照装配（档价×席位 / 档额度×席位 / 周期终点）
 *   - isOneActiveViolation：「单有效订阅」唯一索引并发兜底
 *   - runSubscribeOperation：幂等事务包装（operations.run + 唯一索引映射 already_subscribed）
 */
import { Decimal } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import { REVENUE_ACCOUNT } from '../../domain/wallet/accounts.js';
import { assertSeatsAllowed } from '../../domain/subscription/rules.js';
import { periodEnd } from '../../domain/subscription/rules.js';
import type { PlanRecord } from '../../ports/billing-store.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { AccountContextStore } from '../../ports/account-context.js';
import type { WalletTx } from '../../ports/wallet-store.js';
import { createOperationsUseCase } from '../operations.js';
import type { OperationRun } from '../operations.js';
import type { SubscriptionsEnv } from './subscriptions.js';

/** 动词共享装配：env 显式展开 + 幂等用例（随装配创建一次，无跨请求状态） */
export interface SubscriptionAssembly {
  store: BillingStore;
  accounts: AccountContextStore;
  wallet: SubscriptionsEnv['wallet'];
  clock: () => Date;
  operations: ReturnType<typeof createOperationsUseCase>;
}

/** 装配（工厂收口处一次创建，各动词以显式参数接收——不做依赖捕获） */
export function createSubscriptionAssembly(env: SubscriptionsEnv): SubscriptionAssembly {
  return {
    store: env.store,
    accounts: env.accounts,
    wallet: env.wallet,
    clock: env.clock,
    operations: createOperationsUseCase({ store: env.store }),
  };
}

/** 现金收款：user → platform_revenue（allowCredit:false——禁透支购买） */
export async function chargeCash(
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

/** 套餐闸门（购买/续费/变更共用）：存在/上架/正价/订阅型 + 席位能力 */
export async function assertPlanPurchasable(
  assembly: SubscriptionAssembly,
  tx: WalletTx,
  input: { planId: number; userId: number; quantity: number },
) {
  const { store, accounts } = assembly;
  const plan = await store.findPlan(tx, input.planId);
  if (!plan) throw BillingErrors.business('plan_not_found', { planId: input.planId });
  if (plan.status !== 0) throw BillingErrors.business('plan_disabled', { planId: input.planId });
  // 自助购买闸门：上架套餐必须正价——零价套餐是免费额度印刷机（资损红线）
  if (new Decimal(plan.price).lte(0)) {
    throw BillingErrors.business('plan_not_purchasable', { planId: input.planId });
  }
  if (plan.kind !== 'subscription') {
    throw BillingErrors.business('not_a_pack', { planId: input.planId });
  }
  if (input.quantity > 1 || plan.allowSeats) {
    const isEnterprise = await accounts.isEnterprise(tx, input.userId);
    assertSeatsAllowed({ quantity: input.quantity, allowSeats: plan.allowSeats, isEnterprise });
  }
  return plan;
}

/** 配额快照装配（购买/续费/变更共用）：总价/总额度 = 档价×席位（快照），endAt = 起算+周期 */
export function snapshotPlanForQuantity(
  startAt: Date,
  plan: Pick<PlanRecord, 'price' | 'quotaAmount' | 'periodDays'>,
  quantity: number,
): { endAt: Date; price: string; quotaAmount: string } {
  return {
    endAt: periodEnd(startAt, plan.periodDays),
    price: new Decimal(plan.price).times(quantity).toString(),
    quotaAmount: new Decimal(plan.quotaAmount).times(quantity).toString(),
  };
}

/** 「单有效订阅」唯一索引并发兜底（cause 链上找约束名;SQLSTATE 双字段:pg 在 code、Bun SQL 在 errno） */
export function isOneActiveViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const e = current as { code?: string; errno?: string; constraint?: string; cause?: unknown };
    if (
      (e.code === '23505' || e.errno === '23505') &&
      (e.constraint === 'user_subscriptions_one_active_uq' ||
        e.constraint === 'user_subscriptions_one_org_uq')
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * 幂等事务包装（购买/续费/变更共用）：operations.run 的唯一索引并发兜底映射——
 * already_subscribed（事务回滚可安全重试）。cancel/grantPack 无该竞态路径，直连 operations。
 */
export async function runSubscribeOperation<T extends Record<string, unknown>>(
  assembly: SubscriptionAssembly,
  input: OperationRun<T>,
): Promise<{ receipt: T; replayed: boolean }> {
  try {
    return await assembly.operations.run(input);
  } catch (error) {
    if (isOneActiveViolation(error)) {
      throw BillingErrors.business('subscription_state', { reason: 'already_subscribed' });
    }
    throw error;
  }
}
