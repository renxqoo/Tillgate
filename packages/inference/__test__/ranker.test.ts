import { describe, expect, it } from 'vitest';
import { defaultRoutingPolicy } from '../src/routing/policy';
import { budgetWatermarkFactor, rankChannels } from '../src/routing/ranker';
import type { ChannelCandidate } from '../src/domain/model/types';

const policy = defaultRoutingPolicy();
const rank = (
  rows: Array<Partial<ChannelCandidate> & { id: string; priority: number; weight: number }>,
  rng: () => number,
) =>
  rankChannels({
    channels: rows.map(
      (r) =>
        ({
          channelId: 0,
          channelName: r.id,
          providerName: null,
          protocol: 'p',
          vendor: null,
          baseUrl: 'https://x',
          apiKeyEnc: 'e',
          ...r,
        }) as ChannelCandidate & { id: string },
    ),
    policy,
    ctx: { stickyChannelId: null },
    rng,
  }) as Array<ChannelCandidate & { id: string }>;

describe('routing/ranker：priority 层 + weight 无放回加权随机', () => {
  it('priority 高的层严格在前（同层随机不影响跨层顺序）', () => {
    const rows = [
      { id: 'low-a', priority: 1, weight: 100 },
      { id: 'high-a', priority: 5, weight: 1 },
      { id: 'low-b', priority: 1, weight: 1 },
      { id: 'high-b', priority: 5, weight: 1 },
    ];
    const ordered = rank(rows, Math.random);
    expect(
      ordered
        .map((r) => r.id)
        .slice(0, 2)
        .toSorted(),
    ).toEqual(['high-a', 'high-b']);
    expect(
      ordered
        .map((r) => r.id)
        .slice(2)
        .toSorted(),
    ).toEqual(['low-a', 'low-b']);
  });

  it('weight 是无放回抽取概率：rng 接近 1 时 weight=9 的渠道先出（9/10 首发份额）；rng=0 取首位', () => {
    const rows = [
      { id: 'w1', priority: 0, weight: 1 },
      { id: 'w9', priority: 0, weight: 9 },
    ];
    expect(rank(rows, () => 0.99).map((r) => r.id)).toEqual(['w9', 'w1']);
    expect(rank(rows, () => 0).map((r) => r.id)).toEqual(['w1', 'w9']);
    // 无放回：全部抽出，只是顺序不同（不丢候选）
    expect(
      rank(rows, () => 0.999)
        .map((r) => r.id)
        .toSorted(),
    ).toEqual(['w1', 'w9']);
  });

  it('weight<=0 按 1 处理；全 0 时等概率（不除零、不丢候选）', () => {
    const rows = [
      { id: 'a', priority: 0, weight: 0 },
      { id: 'b', priority: 0, weight: -5 },
      { id: 'c', priority: 0, weight: 0 },
    ];
    const ordered = rank(rows, () => 0.5);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((r) => r.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('空输入返回空数组（无渠道候选的边界）', () => {
    expect(rank([], () => 0)).toEqual([]);
  });

  it('不改动原数组（纯函数——调度不得反向污染目录候选）', () => {
    const rows = [
      { id: 'a', priority: 0, weight: 1 },
      { id: 'b', priority: 0, weight: 1 },
    ];
    rank(rows, () => 0);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('预算软水位降权（budgetWatermarkFactor）', () => {
  it('满水位及以上 → 1；低水位线性下降到 floor 0.1', () => {
    expect(budgetWatermarkFactor({}, 0.2)).toBe(1); // 缺列 = 不降权
    expect(budgetWatermarkFactor({ upstreamBudget: '100', upstreamRemaining: '50' }, 0.2)).toBe(1);
    expect(
      budgetWatermarkFactor({ upstreamBudget: '100', upstreamRemaining: '10' }, 0.2),
    ).toBeCloseTo(0.5);
    expect(
      budgetWatermarkFactor({ upstreamBudget: '100', upstreamRemaining: '0' }, 0.2),
    ).toBeCloseTo(0.1);
    expect(
      budgetWatermarkFactor({ upstreamBudget: '100', upstreamRemaining: '-5' }, 0.2),
    ).toBeCloseTo(0.1); // 超支也只到 floor
    // 关闭（ratio<=0）
    expect(budgetWatermarkFactor({ upstreamBudget: '100', upstreamRemaining: '0' }, 0)).toBe(1);
  });

  it('垃圾/非有限数值按满水位处理（快照列不是资金闸）', () => {
    expect(budgetWatermarkFactor({ upstreamBudget: 'abc', upstreamRemaining: '1' }, 0.2)).toBe(1);
    expect(budgetWatermarkFactor({ upstreamBudget: '0', upstreamRemaining: '0' }, 0.2)).toBe(1); // 预算 0 渠道无水位语义
  });

  it('低水位渠道在同层获得更小流量份额（大样本频率验证）', () => {
    const rich = {
      id: 'rich',
      channelName: 'rich',
      priority: 0,
      weight: 1,
      upstreamBudget: '100',
      upstreamRemaining: '100',
    };
    const poor = {
      id: 'poor',
      channelName: 'poor',
      priority: 0,
      weight: 1,
      upstreamBudget: '100',
      upstreamRemaining: '10',
    };
    const counts = new Map<string, number>([
      ['rich', 0],
      ['poor', 0],
    ]);
    for (let i = 0; i < 2000; i++) {
      const watermarkPolicy = {
        ...defaultRoutingPolicy(),
        scorers: { ...policy.scorers, budgetWatermark: { enabled: true, softRatio: 0.2 } },
      };
      const first = rankChannels({
        channels: [rich, poor] as unknown as Array<ChannelCandidate & { id: string }>,
        policy: watermarkPolicy,
        ctx: { stickyChannelId: null },
        rng: Math.random,
      }).at(0);
      if (first == null) throw new Error('ordering returned empty');
      counts.set(first.channelName, (counts.get(first.channelName) ?? 0) + 1);
    }
    // poor 水位 10% → 因子 0.5 → 期望首发份额 1/3；允许统计波动
    const poorShare = (counts.get('poor') ?? 0) / 2000;
    expect(poorShare).toBeGreaterThan(0.2);
    expect(poorShare).toBeLessThan(0.47);
  });
});

describe('cache 亲和 boost（sticky scorer 确定性）', () => {
  it('sticky 渠道 5x 权重：rng 中段抽中 sticky；关闭时同 rng 抽中另一渠道', () => {
    const chA = {
      channelId: 1,
      channelName: 'a',
      providerName: null,
      protocol: 'p',
      vendor: null,
      baseUrl: 'https://x',
      apiKeyEnc: 'e',
      priority: 10,
      weight: 1,
    } as ChannelCandidate;
    const chB = {
      channelId: 2,
      channelName: 'b',
      providerName: null,
      protocol: 'p',
      vendor: null,
      baseUrl: 'https://x',
      apiKeyEnc: 'e',
      priority: 10,
      weight: 1,
    } as ChannelCandidate;
    const stickyPolicy = {
      ...defaultRoutingPolicy(),
      scorers: {
        ...defaultRoutingPolicy().scorers,
        cacheAffinity: { enabled: true, boost: 5, ttlMs: 300_000, prefixChars: 4_096 },
      },
    };
    // rng=0.5：关闭亲和时 w1:w1 → 落 a；开启 boost 时 1:5 → 0.5 落在 b 段
    // （cacheAffinity 缺省已开启——关闭臂必须显式关，不能靠旧缺省）
    const noAffinityPolicy = {
      ...defaultRoutingPolicy(),
      scorers: {
        ...defaultRoutingPolicy().scorers,
        cacheAffinity: { enabled: false, boost: 3, ttlMs: 300_000, prefixChars: 4_096 },
      },
    };
    expect(
      rankChannels({
        channels: [chA, chB],
        policy: noAffinityPolicy,
        ctx: { stickyChannelId: 2 },
        rng: () => 0.5,
      })[0]?.channelId,
    ).toBe(1);
    expect(
      rankChannels({
        channels: [chA, chB],
        policy: stickyPolicy,
        ctx: { stickyChannelId: 2 },
        rng: () => 0.5,
      })[0]?.channelId,
    ).toBe(2);
    // sticky 渠道不在候选池（已下架）：无 boost 副作用
    expect(
      rankChannels({
        channels: [chA],
        policy: stickyPolicy,
        ctx: { stickyChannelId: 2 },
        rng: () => 0.5,
      })[0]?.channelId,
    ).toBe(1);
  });
});
