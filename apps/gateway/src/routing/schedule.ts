/**
 * 渠道调度排序（app 纯规则——单 app 域不进共享 domain 包）：
 * priority 高的层严格在前；同层内按 weight 做无放回加权随机——weight 是流量份额
 * （weight=9 的渠道获得 ~9/10 的首发流量），而非确定性 tie-break（否则头部渠道
 * 吸收全部流量直到熔断）。weight<=0 按 1 处理（全 0 时等概率）。
 * rng 可注入（可单测的确定性来源；缺省 Math.random）。
 */
export interface SchedulableChannel {
  priority: number;
  weight: number;
}

export function weightedOrderByPriority<T extends SchedulableChannel>(
  candidates: readonly T[],
  rng: () => number = Math.random,
): T[] {
  const tiers = new Map<number, T[]>();
  for (const channel of candidates) {
    const tier = tiers.get(channel.priority);
    if (tier) tier.push(channel);
    else tiers.set(channel.priority, [channel]);
  }
  const ordered: T[] = [];
  for (const priority of [...tiers.keys()].toSorted((a, b) => b - a)) {
    const pool = [...tiers.get(priority)!];
    while (pool.length > 0) {
      const total = pool.reduce((sum, channel) => sum + Math.max(1, channel.weight), 0);
      let pick = rng() * total;
      let index = 0;
      for (; index < pool.length - 1; index++) {
        pick -= Math.max(1, pool[index]!.weight);
        if (pick <= 0) break;
      }
      ordered.push(pool.splice(index, 1)[0]!);
    }
  }
  return ordered;
}
