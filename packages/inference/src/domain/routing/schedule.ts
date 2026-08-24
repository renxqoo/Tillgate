/**
 * 渠道调度排序（v1 gateway routing/schedule.ts 迁移，语义不变）：
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
    const tier = tiers.get(priority);
    // 不可达守卫:priority 键来自 tiers 自身,仅做类型收窄
    if (tier == null) continue;
    const pool = [...tier];
    while (pool.length > 0) {
      const total = pool.reduce((sum, channel) => sum + Math.max(1, channel.weight), 0);
      let pick = rng() * total;
      let index = 0;
      for (; index < pool.length - 1; index++) {
        const candidate = pool[index];
        // 不可达守卫:index < pool.length - 1,仅做类型收窄
        if (candidate == null) break;
        pick -= Math.max(1, candidate.weight);
        if (pick <= 0) break;
      }
      const [picked] = pool.splice(index, 1);
      // 不可达守卫:pool 非空时 splice 必返回一行,仅做类型收窄
      if (picked == null) continue;
      ordered.push(picked);
    }
  }
  return ordered;
}
