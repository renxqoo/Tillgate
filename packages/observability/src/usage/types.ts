/**
 * usage_logs 管理读侧词表(v1 usage-log.repo 管理面族迁入;admin-api P4 消费):
 * 表本身是 billing 的结算投影(写入归 billing settlement),本包只承载运维查询——
 * 管理列表/全局聚合/分组/趋势/渠道首字延迟。SQL 只在 adapters/postgres。
 */

/** 排序白名单(wire 词表单一真相;admin-api contracts 引用不复制) */
export const USAGE_SORT_FIELDS = [
  'id',
  'amount',
  'inputTokens',
  'outputTokens',
  'durationMs',
  'createdAt',
] as const;
export type UsageSortField = (typeof USAGE_SORT_FIELDS)[number];

/** 分组轴(model 为 v1 缺省轴) */
export type UsageGroupAxis = 'user' | 'model' | 'channel';

export interface UsageAdminListInput {
  /** q 命中 外部模型名/真实模型名/requestId(uuid 转文本,ilike) */
  q?: string;
  from?: Date;
  to?: Date;
  userId?: number;
  /** 精确外部模型名(eq) */
  model?: string;
  /** 估算结算行过滤(v1 parseEstimated 显式布尔;undefined = 不过滤) */
  estimated?: boolean;
  sortBy: UsageSortField;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** 管理用量行(v1 listAdminUsage 投影;金额/单价 numeric 全精度字符串,Date 由 presenter 转 ISO) */
export interface UsageAdminRow {
  readonly id: number;
  readonly requestId: string;
  readonly userId: number;
  /** 来源用户展示名(users.displayName 左联;行删除防御下 null) */
  readonly userName: string | null;
  readonly credentialType: string;
  readonly externalModel: string;
  readonly realModel: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly units: number;
  readonly unitPrice: string;
  /** 计价单位(model_mappings 现值关联;token 模型 'token') */
  readonly pricingUnit: string | null;
  readonly amount: string;
  readonly calculatedAmount: string;
  readonly planAmount: string;
  readonly paygAmount: string;
  readonly billedBy: string;
  readonly upstreamCost: string;
  readonly durationMs: number;
  readonly upstreamTtftMs: number | null;
  readonly clientTtftMs: number | null;
  readonly stream: boolean;
  readonly streamAborted: boolean;
  readonly estimated: boolean;
  readonly estimateReason: string | null;
  readonly createdAt: Date;
}

/** 概览·今日聚合(since = 北京时间今日零点,口径在 usage/day-window) */
export interface UsageTodayRow {
  /** 全量行(不筛 status——失败请求也计入今日量;successCount 才筛 status=0) */
  readonly requests: number;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
  readonly successCount: number;
}

/** 概览·累计 */
export interface UsageTotalsRow {
  readonly cost: string;
  readonly requests: number;
}

/** 概览·渠道状态分组计数 */
export interface ChannelStatusCount {
  readonly status: number;
  readonly count: number;
}

/** 分组聚合存储行(pg bigint 聚合回传字符串——应用层统一 Number 映射) */
export interface UsageGroupStoreRow {
  readonly key: string | number | null;
  readonly requests: number;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cachedInputTokens: string;
  readonly cost: string;
  readonly upstreamCost: string;
}

/** 分组聚合出口行(tokens 已映射 number;金额保持字符串) */
export interface UsageGroupRow extends Omit<
  UsageGroupStoreRow,
  'inputTokens' | 'outputTokens' | 'cachedInputTokens'
> {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

/** 按日趋势存储行(date = 'YYYY-MM-DD' 北京日界字符串) */
export interface UsageTrendStoreRow {
  readonly date: string;
  readonly requests: number;
  readonly successCount: number;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
}

/** 按日趋势出口行(tokens 已映射 number) */
export interface UsageTrendRow extends Omit<UsageTrendStoreRow, 'inputTokens' | 'outputTokens'> {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 渠道首字延迟聚合(双向 P50/P95;延迟取整毫秒在 adapter 完成——展示统计非资金运算) */
export interface ChannelTtftRow {
  readonly channelId: number | null;
  readonly channelName: string | null;
  readonly samples: number;
  readonly upstreamP50: number | null;
  readonly upstreamP95: number | null;
  readonly clientP50: number | null;
  readonly clientP95: number | null;
}

/** usage_logs 运维查询存储 port(生产 postgres;测试内存替身) */
export interface UsageStatsStore {
  /** 管理列表:恒 status=0(只看已计费行);q 三路 ilike;排序列白名单 + id 稳定序 */
  adminList(input: UsageAdminListInput): Promise<{ rows: UsageAdminRow[]; total: number }>;
  /** 概览·今日(全量行不筛 status) */
  overviewToday(since: Date): Promise<UsageTodayRow>;
  /** 概览·累计(总消费与总请求数) */
  overviewTotals(): Promise<UsageTotalsRow>;
  /** 概览·渠道状态分组(channels 表全量) */
  channelStatusCounts(): Promise<ChannelStatusCount[]>;
  /** 分组聚合(user/model/channel 三轴;按消费降序 limit 200) */
  usageGroups(input: {
    group: UsageGroupAxis;
    from?: Date;
    to?: Date;
  }): Promise<UsageGroupStoreRow[]>;
  /** 按日趋势(from = 北京日界 N 天前;只带下界——今日子集随时间自然增长) */
  dailyTrends(from: Date): Promise<UsageTrendStoreRow[]>;
  /** 渠道首字延迟(只统计流式成功样本;percentile_cont 库端聚合) */
  channelTtft(since: Date): Promise<ChannelTtftRow[]>;
}
