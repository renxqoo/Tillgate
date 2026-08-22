/**
 * 瀑布① 规划（不动账）：probe 循环定各源份额——authorize 在 INSERT 前调用，
 * 投影三列（reserved / plan_reserved / subscription_id）全部从 plan 算出。
 * 零金额返回空计划（免费快路径）；全链加总不足一律 fail-closed（insufficient_balance）。
 * probe 抛错（结构性非法 / 开关 OFF 覆盖不足）原样上抛中断整个授权。
 * ② 提交在 commit.ts——两阶段之间由 authorize 的 advisory 锁保证同 user 无竞态。
 */
import { Decimal } from '../../../domain/money.js';
import { BillingErrors } from '../../../domain/errors.js';
import type { WalletTx } from '../../../ports/wallet-store.js';
import type { FundingRegistry } from './registry.js';
import type { FundingSource, FundingSourceContext } from './source.js';

export interface FundingPlanEntry {
  source: FundingSource;
  take: Decimal;
}

export interface FundingPlan {
  context: FundingSourceContext;
  entries: readonly FundingPlanEntry[];
  /** 投影列：订阅份额（无订阅份额为 null——开关 ON 且额度耗尽时补差不落订阅） */
  planReservedAmount: string | null;
  subscriptionId: number | null;
}

export interface PlanFundingInput {
  userId: number;
  requestId: string;
  /** 计费币种（装配注入——错误回执与来源上下文的口径） */
  currency: string;
  credential: { apiKeyId: number | null; appId: number | null };
  /** 预解析结果（authorize 的 resolver 一次查出） */
  resolved: { subscriptionId: number | null; allowPaygFallback: boolean };
  amount: string;
  now: Date;
}

export async function planFunding(
  registry: FundingRegistry,
  tx: WalletTx,
  input: PlanFundingInput,
): Promise<FundingPlan> {
  const context: FundingSourceContext = {
    userId: input.userId,
    currency: input.currency,
    credential: input.credential,
    resolved: input.resolved,
  };
  if (new Decimal(input.amount).isZero()) {
    return {
      context,
      entries: [],
      planReservedAmount: null,
      subscriptionId: input.resolved.subscriptionId,
    };
  }

  let remaining = new Decimal(input.amount);
  const entries: FundingPlanEntry[] = [];
  for (const source of registry.resolve(context)) {
    if (remaining.isZero()) break;
    // 契约：probe 返回 ≥ 0；不可用的可选来源返回 0 → 跳过
    const available = await source.probe(tx, {
      userId: input.userId,
      requestId: input.requestId,
      amount: remaining.toString(),
      now: input.now,
      context,
    });
    const take = Decimal.min(available, remaining);
    if (take.gt(0)) entries.push({ source, take });
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    const planned = entries.reduce<Decimal>((sum, e) => sum.plus(e.take), new Decimal(0));
    throw BillingErrors.business('insufficient_balance', {
      userId: input.userId,
      available: planned.toString(),
      required: input.amount,
      currency: input.currency,
    });
  }

  const subscriptionEntry = entries.find((entry) => entry.source.type === 'subscription');
  return {
    context,
    entries,
    planReservedAmount: subscriptionEntry ? subscriptionEntry.take.toString() : null,
    subscriptionId: input.resolved.subscriptionId,
  };
}
