import { beijingDayStart, beijingTrendsFrom } from './day-window';
import type {
  ChannelStatusCount,
  ChannelTtftRow,
  UsageAdminListInput,
  UsageAdminRow,
  UsageGroupRow,
  UsageGroupAxis,
  UsageStatsStore,
} from './types';

/**
 * usage 运维查询信封(v1 ops-logs.service 的 statsUsage/statsTrends/statsOverview
 * 口径层逐语义迁入):日界计算、failedCount/successRate 派生、pg bigint 字符串
 * → number 映射全部在此;store 原语保持纯 SQL 语义。now 由调用方注入
 * (requestLogs.list 的 input.now 同构——facade 不持时钟)。
 */
export interface UsageQueries {
  /** 管理用量列表(信封透传;过滤/排序语义在 store) */
  adminList(input: UsageAdminListInput): Promise<{ rows: UsageAdminRow[]; total: number }>;
  /** 概览:今日(北京日界)+ 累计 + 渠道状态分组 */
  overview(input: { now: Date }): Promise<{
    today: {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: string;
      successCount: number;
      failedCount: number;
      successRate: number;
    };
    total: { cost: string; requests: number };
    channelHealth: ChannelStatusCount[];
  }>;
  /** 分组聚合(user/model/channel;tokens 映射 number,金额保持字符串) */
  groups(input: { group: UsageGroupAxis; from?: Date; to?: Date }): Promise<{ list: UsageGroupRow[] }>;
  /** 按日趋势:近 N 天(含今日;北京日界) */
  trends(input: { days: number; now: Date }): Promise<{
    days: number;
    rows: Array<{
      date: string;
      requests: number;
      successCount: number;
      inputTokens: number;
      outputTokens: number;
      cost: string;
    }>;
  }>;
  /** 渠道首字延迟 P50/P95(双向;窗口 = now - hours) */
  channelTtft(input: { hours: number; now: Date }): Promise<{ rows: ChannelTtftRow[] }>;
}

export function createUsageQueries(env: { store: UsageStatsStore }): UsageQueries {
  const { store } = env;
  return {
    adminList: (input) => store.adminList(input),

    async overview(input) {
      // 「今日」按北京时间零点切日(面板/计价面向中国时区;day-window 单一口径)
      const since = beijingDayStart(input.now);
      const [today, totals, channelHealth] = await Promise.all([
        store.overviewToday(since),
        store.overviewTotals(),
        store.channelStatusCounts(),
      ]);
      const failedCount = today.requests - today.successCount;
      // 一位小数百分比(v1 舍入口径:round(x*1000)/10;零请求恒 0)
      const successRate =
        today.requests === 0
          ? 0
          : Math.round((today.successCount / today.requests) * 1000) / 10;
      return {
        today: {
          requests: today.requests,
          inputTokens: Number(today.inputTokens),
          outputTokens: Number(today.outputTokens),
          cost: today.cost,
          successCount: today.successCount,
          failedCount,
          successRate,
        },
        total: { cost: totals.cost, requests: totals.requests },
        channelHealth,
      };
    },

    async groups(input) {
      const list = await store.usageGroups(input);
      return {
        list: list.map((row) => ({
          ...row,
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
          cachedInputTokens: Number(row.cachedInputTokens),
        })),
      };
    },

    async trends(input) {
      const from = beijingTrendsFrom(input.days, input.now);
      const rows = await store.dailyTrends(from);
      return {
        days: input.days,
        rows: rows.map((row) => ({
          ...row,
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
        })),
      };
    },

    async channelTtft(input) {
      const since = new Date(input.now.getTime() - input.hours * 3_600_000);
      return { rows: await store.channelTtft(since) };
    },
  };
}
