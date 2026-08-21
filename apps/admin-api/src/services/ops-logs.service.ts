/**
 * 运维查询服务族（纯读侧）：用量明细 / 请求日志 / 审计日志 / 支付订单 /
 * 生成任务 / 统计。SQL 全在 repository；本层只做口径与信封。
 *
 * usage-logs 专项语义：estimated 过滤是字符串布尔显式解析
 * （'true'/'1' → true；coerce.boolean 会把 'false' 变 true——陷阱有回归锁定）；
 * 恒 status=0（只看已计费行）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const USAGE_SORTS = [
  'id',
  'amount',
  'inputTokens',
  'outputTokens',
  'durationMs',
  'createdAt',
] as const;
export const LOG_SORTS = ['id', 'statusCode', 'durationMs', 'createdAt'] as const;
export const AUDIT_SORTS = ['id', 'action', 'createdAt'] as const;
export const ORDER_SORTS = ['id', 'amount', 'status', 'createdAt'] as const;

/** 字符串布尔（'true'/'1' → true，其余 → false——coerce 陷阱的显式解法） */
export const parseEstimated = (raw: string | undefined): boolean | undefined =>
  raw === undefined ? undefined : raw === 'true' || raw === '1';

export interface OpsLogsServiceDeps {
  db: Db;
  repos?: Repositories;
  clock?: () => Date;
}

export interface OpsLogsService {
  usageLogs(
    ctx: RunContext,
    input: {
      query: ListQueryParts;
      from?: Date;
      to?: Date;
      userId?: number;
      model?: string;
      estimated?: boolean;
    },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  requestLogs(
    ctx: RunContext,
    input: {
      query: ListQueryParts;
      from?: Date;
      to?: Date;
      userId?: number;
      statusCode?: number | '2xx' | '4xx' | '5xx';
    },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  auditLogs(
    ctx: RunContext,
    query: ListQueryParts,
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  paymentOrders(
    ctx: RunContext,
    input: { query: ListQueryParts },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  closePaymentOrder(
    ctx: RunContext,
    input: { adminId: number; orderId: string },
  ): Promise<{ ok: true }>;
  generationTasks(
    ctx: RunContext,
    input: { kind?: 'video' | 'music'; status?: string; limit: number; offset: number },
  ): Promise<{ items: unknown[]; total: number }>;
  statsOverview(ctx: RunContext): Promise<{
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
    channelHealth: Array<{ status: number; count: number }>;
  }>;
  statsUsage(
    ctx: RunContext,
    input: { group: 'user' | 'model' | 'channel'; from?: Date; to?: Date },
  ): Promise<{ list: unknown[] }>;
  /** 按日趋势（仪表盘折线图）：近 N 天（北京时间日界）的请求/成功/token/消耗 */
  statsTrends(
    ctx: RunContext,
    input: { days: number },
  ): Promise<{
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
  /** 渠道首字延迟 P50/P95（双向；拓扑页/选渠道排障数据源） */
  channelTtft(ctx: RunContext, input: { hours: number }): Promise<{ rows: unknown[] }>;
}

export function createOpsLogsService(deps: OpsLogsServiceDeps): OpsLogsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());

  return {
    async usageLogs(ctx, input) {
      const result = await repos.usageLog.listAdminUsage(
        { db, ...ctx },
        {
          q: input.query.q,
          from: input.from,
          to: input.to,
          userId: input.userId,
          model: input.model,
          estimated: input.estimated,
          sortBy: input.query.sortBy as (typeof USAGE_SORTS)[number],
          order: input.query.order,
          limit: input.query.limit,
          offset: input.query.offset,
        },
      );
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    async requestLogs(ctx, input) {
      const result = await repos.usageLog.listRequestLogs(
        { db, ...ctx },
        {
          q: input.query.q,
          from: input.from,
          to: input.to,
          userId: input.userId,
          statusCode: input.statusCode,
          sortBy: input.query.sortBy as (typeof LOG_SORTS)[number],
          order: input.query.order,
          limit: input.query.limit,
          offset: input.query.offset,
          now: clock(),
        },
      );
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    async auditLogs(ctx, query) {
      const result = await repos.auditLog.list(
        { db, ...ctx },
        {
          q: query.q,
          sortBy: query.sortBy as (typeof AUDIT_SORTS)[number],
          order: query.order,
          limit: query.limit,
          offset: query.offset,
        },
      );
      return { rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize };
    },

    async paymentOrders(ctx, input) {
      const result = await repos.paymentOrder.listAdminOrders(
        { db, ...ctx },
        {
          q: input.query.q,
          sortBy: input.query.sortBy as (typeof ORDER_SORTS)[number],
          order: input.query.order,
          limit: input.query.limit,
          offset: input.query.offset,
        },
      );
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    async closePaymentOrder(ctx, input) {
      const closed = await repos.paymentOrder.closeOrder(
        { db, ...ctx },
        {
          orderId: input.orderId,
          reason: '管理员手动关闭',
        },
      );
      if (!closed) {
        throw new AppError(409, 'conflict', 'Order not found or status does not allow closing');
      }
      return { ok: true as const };
    },

    async generationTasks(ctx, input) {
      const statuses = ['queued', 'running', 'succeeded', 'failed', 'expired'] as const;
      const status =
        input.status && statuses.includes(input.status as (typeof statuses)[number])
          ? (input.status as (typeof statuses)[number])
          : undefined;
      const result = await repos.generationTask.listAdminTasks(
        { db, ...ctx },
        {
          kind: input.kind,
          status,
          limit: input.limit,
          offset: input.offset,
        },
      );
      // 已结算任务的实扣金额批量回填（task.id 即计费 requestId 惯例）
      const rows = result.rows as Array<{ id: string; billingStatus: string | null }>;
      const settled = rows.filter((r) => r.billingStatus === 'settled').map((r) => r.id);
      const amounts = await repos.generationTask.findSettledAmounts({ db, ...ctx }, settled);
      const items = rows.map((r) => ({
        ...r,
        settledAmount: amounts.get(r.id) ?? null,
      }));
      return { items, total: result.total };
    },

    async statsOverview(ctx) {
      const now = clock();
      // 「今日」按北京时间零点切日（面板/计价面向中国时区；UTC 零点会把早 8 点前的量算进昨日）
      const bj = new Date(now.getTime() + 8 * 3_600_000);
      const since = new Date(
        Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3_600_000,
      );
      const [today, totals, channelHealth] = await Promise.all([
        repos.usageLog.statsOverviewToday({ db, ...ctx }, since),
        repos.usageLog.statsTotals({ db, ...ctx }),
        repos.usageLog.statsChannelHealth({ db, ...ctx }),
      ]);
      const failedCount = today.requests - today.successCount;
      const successRate =
        today.requests === 0 ? 0 : Math.round((today.successCount / today.requests) * 1000) / 10;
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

    async statsUsage(ctx, input) {
      const list = await repos.usageLog.statsUsageGroups({ db, ...ctx }, input);
      return {
        list: list.map((row) => ({
          ...row,
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
          cachedInputTokens: Number(row.cachedInputTokens),
        })),
      };
    },

    async statsTrends(ctx, input) {
      // 近 N 天（含今日），日界与 statsOverview 同为北京时间零点
      const bj = new Date(clock().getTime() + 8 * 3_600_000);
      const todayZeroUtc =
        Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3_600_000;
      const from = new Date(todayZeroUtc - (input.days - 1) * 86_400_000);
      const rows = await repos.usageLog.statsDailyTrends({ db, ...ctx }, from);
      return {
        days: input.days,
        rows: rows.map((row) => ({
          ...row,
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
        })),
      };
    },

    async channelTtft(ctx, input) {
      const since = new Date(clock().getTime() - input.hours * 3_600_000);
      return { rows: await repos.usageLog.channelTtftStats({ db, ...ctx }, { since }) };
    },
  };
}
