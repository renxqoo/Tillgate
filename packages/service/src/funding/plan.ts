/**
 * 瀑布① 规划（不动账）：probe 循环定各源份额——authorize 在 INSERT 前调用，
 * 投影三列（reserved / plan_reserved / subscription_id）全部从 plan 算出。
 * 零金额返回空计划（免费快路径）；全链加总不足 → 放行门（admission）：
 *   未配阈值（缺省 fail-closed）→ InsufficientBalanceError；
 *   配置 balanceFloor（预扣策略，billing_config.reservation）→ 实筹 ≥ 阈值即放行，
 *   hold = 实筹份额（敞口由结算 §4 补充授权兜底）。
 * probe 抛错（结构性非法 / 开关 OFF 覆盖不足）原样上抛中断整个授权。
 * ② 提交在 commit.ts——两阶段之间由 authorize 的 advisory 锁保证同 user 无竞态。
 */
import { admitsReservation, Decimal, InsufficientBalanceError } from '@ai-gateway/domain';
import type { RepoContext } from '@ai-gateway/repository';
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
  /** 预解析结果（authorize 的 resolveSourceAndLimits 一次查出，§3.10） */
  resolved: { subscriptionId: number | null; allowPaygFallback: boolean };
  amount: string;
  now: Date;
  /** 放行阈值（候选链最严 balanceFloor；null = 足额 fail-closed）——预扣策略注入 */
  balanceFloor?: string | null;
}

export async function planFunding(
  registry: FundingRegistry,
  c: RepoContext,
  input: PlanFundingInput,
): Promise<FundingPlan> {
  const context: FundingSourceContext = {
    userId: input.userId,
    currency: input.currency,
    credential: input.credential,
    resolved: input.resolved,
  };
  if (new Decimal(input.amount).isZero()) {
    return { context, entries: [], planReservedAmount: null, subscriptionId: input.resolved.subscriptionId };
  }

  let remaining = new Decimal(input.amount);
  const entries: FundingPlanEntry[] = [];
  for (const source of registry.resolve(context)) {
    if (remaining.isZero()) break;
    // 契约：probe 返回 ≥ 0；不可用的可选来源返回 0 → 跳过
    const available = await source.probe(c, {
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
    // 放行门：实筹份额（Σ entries.take）是否可接受——策略阈值或缺省足额
    const planned = entries.reduce<Decimal>((sum, e) => sum.plus(e.take), new Decimal(0));
    if (!admitsReservation(input.balanceFloor ?? null, planned, new Decimal(input.amount))) {
      throw new InsufficientBalanceError(input.userId, planned.toString(), input.amount, input.currency);
    }
  }

  const subscriptionEntry = entries.find((entry) => entry.source.type === 'subscription');
  return {
    context,
    entries,
    planReservedAmount: subscriptionEntry ? subscriptionEntry.take.toString() : null,
    subscriptionId: input.resolved.subscriptionId,
  };
}
