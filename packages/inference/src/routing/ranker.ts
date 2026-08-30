import type { ChannelCandidate } from '../domain/model/types';
import type { RoutingPolicy } from './policy';

/**
 * 渠道排序引擎（组件化核心）：priority 严格分层（运营意图）+ 层内
 * weight × Π(scorer 因子) 无放回加权随机（流量份额制——抗羊群）。
 *
 * 评分器组件约定：数据获取（异步，一次批量）与打分（同步纯函数）分离——
 * ranker 先解析上下文（sticky 命中等），scorers 只做乘法。新评分器 =
 * 实现 ChannelScorer + 在 buildScorers 注册 + policy 加参数段，三步接入。
 */

export interface RankContext {
  /** cache 亲和命中的渠道（无 = null；不健康渠道由 gates 拦，打分不判健康） */
  stickyChannelId: number | null;
}

export interface ChannelScorer {
  name: 'budget-watermark' | 'cache-affinity';
  /** 权重乘数：>=0.1（floor——不归零，归零等于禁用试探流量） */
  factor(channel: ChannelCandidate): number;
}

/** 预算软水位：remaining/budget 低于 softRatio 起线性降权（硬闸在 reserveChannel 兜底） */
export function budgetWatermarkFactor(
  channel: Pick<ChannelCandidate, 'upstreamBudget' | 'upstreamRemaining'>,
  softRatio: number,
): number {
  if (channel.upstreamBudget == null || channel.upstreamRemaining == null) return 1;
  const budget = Number(channel.upstreamBudget);
  const remaining = Number(channel.upstreamRemaining);
  if (!Number.isFinite(budget) || !Number.isFinite(remaining) || budget <= 0) return 1;
  const ratio = remaining / budget;
  if (ratio >= softRatio) return 1;
  return Math.max(0.1, ratio / softRatio);
}

/** 按策略段装配评分器管线（注册表——新增评分器在此登记） */
export function buildScorers(policy: RoutingPolicy, ctx: RankContext): ChannelScorer[] {
  const scorers: ChannelScorer[] = [];
  if (policy.scorers.budgetWatermark.enabled) {
    const { softRatio } = policy.scorers.budgetWatermark;
    scorers.push({
      name: 'budget-watermark',
      factor: (ch) => budgetWatermarkFactor(ch, softRatio),
    });
  }
  if (policy.scorers.cacheAffinity.enabled && ctx.stickyChannelId != null) {
    const { boost } = policy.scorers.cacheAffinity;
    const stickyId = ctx.stickyChannelId;
    scorers.push({
      name: 'cache-affinity',
      factor: (ch) => (ch.channelId === stickyId ? boost : 1),
    });
  }
  return scorers;
}

/** 层内有效权重（weight × Π因子，floor 0.1） */
export function effectiveWeightOf(
  channel: Pick<ChannelCandidate, 'weight'>,
  scorers: readonly ChannelScorer[],
): number {
  let factor = 1;
  for (const scorer of scorers) factor *= scorer.factor(channel as ChannelCandidate);
  return Math.max(0.1, Math.max(1, channel.weight) * factor);
}

/**
 * 单渠道直连模式的首选渠道（policy.enabled=false 时使用——用户裁决 D1）：
 * priority 降序 → weight 降序 → channelId 升序，确定性取第一名，不随机、
 * 不挂 scorer。空候选集返回 undefined（调用方落 no_available_channel 终局）。
 */
export function pickPrimaryChannel(
  channels: readonly ChannelCandidate[],
): ChannelCandidate | undefined {
  return [...channels].toSorted(
    (a, b) => b.priority - a.priority || b.weight - a.weight || a.channelId - b.channelId,
  )[0];
}

/** 排序主入口：分层 + 层内加权随机（rng 可注入，确定性单测） */
export function rankChannels(input: {
  channels: readonly ChannelCandidate[];
  policy: RoutingPolicy;
  ctx: RankContext;
  rng?: () => number;
}): ChannelCandidate[] {
  const { channels, policy, ctx } = input;
  const rng = input.rng ?? Math.random;
  const scorers = buildScorers(policy, ctx);
  const tiers = new Map<number, ChannelCandidate[]>();
  for (const channel of channels) {
    const tier = tiers.get(channel.priority);
    if (tier) tier.push(channel);
    else tiers.set(channel.priority, [channel]);
  }
  const ordered: ChannelCandidate[] = [];
  for (const priority of [...tiers.keys()].toSorted((a, b) => b - a)) {
    const pool = [...(tiers.get(priority) ?? [])];
    while (pool.length > 0) {
      const total = pool.reduce((sum, ch) => sum + effectiveWeightOf(ch, scorers), 0);
      let pick = rng() * total;
      let index = 0;
      for (; index < pool.length - 1; index++) {
        pick -= effectiveWeightOf(pool[index] as ChannelCandidate, scorers);
        if (pick <= 0) break;
      }
      const [picked] = pool.splice(index, 1);
      if (picked != null) ordered.push(picked);
    }
  }
  return ordered;
}
