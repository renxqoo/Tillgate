import { describe, expect, it, vi } from 'vitest';
import { beijingDayStart, beijingTrendsFrom } from '../src/usage/day-window';
import { createUsageQueries } from '../src/usage/queries';
import { USAGE_SORT_FIELDS } from '../src/usage/types';
import type { UsageStatsStore } from '../src/usage/types';

/**
 * usage 运维读侧口径测试(v1 ops-logs.service 行为规格的口径面):
 * 北京日界纯函数边界 / 概览派生(failedCount/successRate 舍入)/ bigint 字符串
 * → number 映射 / 趋势窗口计算 / TTFT 窗口换算。SQL 行为由 postgres.real.test.ts 承担。
 */

const noRows = async () => {
  throw new Error('not wired');
};

/** 最小 store 替身:各方法默认拒绝,按用例覆写(v1 repo 语义的内存镜像) */
function fakeStore(overrides: Partial<UsageStatsStore> = {}): UsageStatsStore {
  return {
    adminList: noRows as UsageStatsStore['adminList'],
    overviewToday: noRows,
    overviewTotals: noRows,
    channelStatusCounts: noRows,
    usageGroups: noRows,
    dailyTrends: noRows,
    channelTtft: noRows,
    ...overrides,
  };
}

describe('beijingDayStart(北京日界)', () => {
  it('UTC 16:00 前 = 昨日 16:00 起点;16:00 起 = 当日起点(切日边界)', () => {
    // UTC 2026-08-22 15:59:59 → 北京 23:59:59,属 08-22 日 → 起点 = UTC 08-21 16:00
    expect(beijingDayStart(new Date('2026-08-22T15:59:59.999Z'))).toEqual(
      new Date('2026-08-21T16:00:00.000Z'),
    );
    // UTC 16:00:00 整 → 北京 00:00,切进 08-23 日
    expect(beijingDayStart(new Date('2026-08-22T16:00:00.000Z'))).toEqual(
      new Date('2026-08-22T16:00:00.000Z'),
    );
    // UTC 00:00(北京 08:00)→ 当日起点 = 前一 UTC 日 16:00
    expect(beijingDayStart(new Date('2026-08-23T00:00:00.000Z'))).toEqual(
      new Date('2026-08-22T16:00:00.000Z'),
    );
  });

  it('trendsFrom:近 N 天含今日(days=1 即今日零点;days=14 回退 13 天)', () => {
    const now = new Date('2026-08-23T10:30:00.000Z');
    expect(beijingTrendsFrom(1, now)).toEqual(beijingDayStart(now));
    expect(beijingTrendsFrom(14, now).getTime()).toBe(
      beijingDayStart(now).getTime() - 13 * 86_400_000,
    );
  });
});

describe('usage queries(概览/分组/趋势/TTFT 口径)', () => {
  it('overview:三查并发 + failedCount/successRate 一位小数舍入 + tokens number 映射', async () => {
    const today = vi.fn(async () => ({
      requests: 7,
      inputTokens: '123',
      outputTokens: '456',
      cost: '1.23',
      successCount: 6,
    }));
    const totals = vi.fn(async () => ({ cost: '99.5', requests: 1000 }));
    const health = vi.fn(async () => [{ status: 0, count: 3 }]);
    const queries = createUsageQueries({
      store: fakeStore({
        overviewToday: today,
        overviewTotals: totals,
        channelStatusCounts: health,
      }),
    });
    const now = new Date('2026-08-23T10:00:00.000Z');
    const result = await queries.overview({ now });
    // 今日窗口按北京日界下推给 store
    expect(today).toHaveBeenCalledWith(beijingDayStart(now));
    expect(result.today).toEqual({
      requests: 7,
      inputTokens: 123,
      outputTokens: 456,
      cost: '1.23',
      successCount: 6,
      failedCount: 1,
      successRate: 85.7, // 6/7 = 85.714…% → round(857.14)/10
    });
    expect(result.total).toEqual({ cost: '99.5', requests: 1000 });
    expect(result.channelHealth).toEqual([{ status: 0, count: 3 }]);
  });

  it('overview:零请求恒 0 不做除零(v1 语义)', async () => {
    const queries = createUsageQueries({
      store: fakeStore({
        overviewToday: async () => ({
          requests: 0,
          inputTokens: '0',
          outputTokens: '0',
          cost: '0',
          successCount: 0,
        }),
        overviewTotals: async () => ({ cost: '0', requests: 0 }),
        channelStatusCounts: async () => [],
      }),
    });
    const result = await queries.overview({ now: new Date() });
    expect(result.today).toMatchObject({ failedCount: 0, successRate: 0 });
  });

  it('groups:三 token 列 number 映射,金额/上游成本保持字符串', async () => {
    const queries = createUsageQueries({
      store: fakeStore({
        usageGroups: async () => [
          {
            key: 'gpt-4o',
            requests: 5,
            inputTokens: '10',
            outputTokens: '20',
            cachedInputTokens: '30',
            cost: '0.5',
            upstreamCost: '0.2',
          },
        ],
      }),
    });
    const result = await queries.groups({ group: 'model' });
    expect(result.list).toEqual([
      {
        key: 'gpt-4o',
        requests: 5,
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 30,
        cost: '0.5',
        upstreamCost: '0.2',
      },
    ]);
  });

  it('trends:days 透传 + from 窗口下推 + token 列映射', async () => {
    const daily = vi.fn(async () => [
      {
        date: '2026-08-22',
        requests: 4,
        successCount: 3,
        inputTokens: '100',
        outputTokens: '200',
        cost: '0.4',
      },
    ]);
    const queries = createUsageQueries({ store: fakeStore({ dailyTrends: daily }) });
    const now = new Date('2026-08-23T02:00:00.000Z');
    const result = await queries.trends({ days: 14, now });
    expect(daily).toHaveBeenCalledWith(beijingTrendsFrom(14, now));
    expect(result.days).toBe(14);
    expect(result.rows).toEqual([
      {
        date: '2026-08-22',
        requests: 4,
        successCount: 3,
        inputTokens: 100,
        outputTokens: 200,
        cost: '0.4',
      },
    ]);
  });

  it('channelTtft:窗口 = now - hours 小时下推 store', async () => {
    const ttft = vi.fn(async () => []);
    const queries = createUsageQueries({ store: fakeStore({ channelTtft: ttft }) });
    const now = new Date('2026-08-23T12:00:00.000Z');
    await queries.channelTtft({ hours: 24, now });
    expect(ttft).toHaveBeenCalledWith(new Date('2026-08-22T12:00:00.000Z'));
  });

  it('adminList:输入透传 store(过滤/排序语义单点在 adapter)', async () => {
    const adminList = vi.fn(async () => ({ rows: [], total: 0 }));
    const queries = createUsageQueries({ store: fakeStore({ adminList }) });
    const input = {
      q: 'gpt',
      from: new Date('2026-08-01T00:00:00Z'),
      userId: 9,
      model: 'gpt-4o',
      estimated: false,
      sortBy: 'amount' as const,
      order: 'desc' as const,
      limit: 20,
      offset: 0,
    };
    await queries.adminList(input);
    expect(adminList).toHaveBeenCalledWith(input);
  });
});

describe('词表封闭(契约级,§10.1)', () => {
  it('排序白名单 = v1 USAGE_SORTS 逐字', () => {
    expect(USAGE_SORT_FIELDS).toEqual([
      'id',
      'amount',
      'inputTokens',
      'outputTokens',
      'durationMs',
      'createdAt',
    ]);
  });
});
