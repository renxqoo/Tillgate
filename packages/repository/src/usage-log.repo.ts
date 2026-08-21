/**
 * usage_logs 仓储：结算投影写 + 限额读模型（已结算消费口径）+ 用户面读侧。
 * usage_logs 不是资金流水——资金事实在 wallet statement；此表承载计量/计价快照与归属维度。
 */
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import {
  apiKeys,
  apps,
  channels,
  requestLogs,
  usageLogs,
  users,
  modelMappings,
} from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

/** 用户面用量明细行（key/app 来源名由左联带出） */
export interface UsageRow {
  id: number;
  requestId: string;
  credentialType: string;
  externalModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  units: number;
  /** 单位计价行（图片张/音频秒/语音字符/按次）；token 行 0 */
  unitPrice: string | null;
  /** 计价单位（token 模型 null——按 model_mappings 现值关联） */
  pricingUnit: string | null;
  amount: string;
  billedBy: string;
  planAmount: string;
  paygAmount: string;
  durationMs: number;
  stream: boolean;
  estimated: boolean;
  createdAt: Date;
  keyName: string | null;
  appName: string | null;
}

/** usage_logs 仓储（无状态；方法统一接收 RepoContext） */
export class UsageLogRepository {
  /** 结算投影落库（requestId 唯一约束幂等）：false=已存在（重复落库=不变量红灯信号） */
  async insertUsageLog(c: RepoContext, values: typeof usageLogs.$inferInsert): Promise<boolean> {
    const rows = await tx(c)
      .insert(usageLogs)
      .values(values)
      .onConflictDoNothing({ target: usageLogs.requestId })
      .returning({ id: usageLogs.id });
    return rows.length > 0;
  }

  /** /v1/* 请求日志（鉴权前的 401/429 也记——审计与观测，非资金事实） */
  async insertRequestLog(
    c: RepoContext,
    values: {
      requestId: string;
      userId: number | null;
      apiKeyId: number | null;
      method: string;
      path: string;
      statusCode: number;
      errorCode: string | null;
      durationMs: number;
      requestSummary: Record<string, unknown> | null;
      sourceIp: string | null;
    },
  ): Promise<void> {
    await c.db.insert(requestLogs).values(values);
  }

  /** 结算幂等回查：该请求的已结算金额（认领失效时判 already_settled） */
  async findAmount(c: RepoContext, requestId: string): Promise<string | null> {
    const [row] = await c.db
      .select({ amount: usageLogs.amount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, requestId));
    return row?.amount ?? null;
  }

  /**
   * 渠道首字延迟聚合（P50/P95，双向：上游/客户端）——运营侧「哪个渠道首字慢」的数据源。
   * 只统计流式成功样本（ttft 列流式专属）；SQL 侧 percentile_cont（数据库完成聚合）。
   */
  async channelTtftStats(
    c: RepoContext,
    dims: { since: Date },
  ): Promise<
    Array<{
      channelId: number | null;
      channelName: string | null;
      samples: number;
      upstreamP50: number | null;
      upstreamP95: number | null;
      clientP50: number | null;
      clientP95: number | null;
    }>
  > {
    const result = await c.db.execute<{
      channel_id: number | null;
      channel_name: string | null;
      samples: number;
      upstream_p50: number | null;
      upstream_p95: number | null;
      client_p50: number | null;
      client_p95: number | null;
    }>(sql`
      select u.channel_id,
             ch.name as channel_name,
             count(*)::int as samples,
             percentile_cont(0.5) within group (order by u.upstream_ttft_ms) as upstream_p50,
             percentile_cont(0.95) within group (order by u.upstream_ttft_ms) as upstream_p95,
             percentile_cont(0.5) within group (order by u.client_ttft_ms) as client_p50,
             percentile_cont(0.95) within group (order by u.client_ttft_ms) as client_p95
      from usage_logs u
      left join channels ch on ch.id = u.channel_id
      where u.status = 0 and u.stream = true and u.client_ttft_ms is not null
        and u.created_at >= ${dims.since}
      group by u.channel_id, ch.name
      order by samples desc
      limit 100
    `);
    return result.rows.map((r) => ({
      // pg int8 回传为字符串（同文件 raw execute 惯例）——显式 Number 映射
      channelId: r.channel_id == null ? null : Number(r.channel_id),
      channelName: r.channel_name,
      samples: r.samples,
      upstreamP50: r.upstream_p50 == null ? null : Math.round(Number(r.upstream_p50)),
      upstreamP95: r.upstream_p95 == null ? null : Math.round(Number(r.upstream_p95)),
      clientP50: r.client_p50 == null ? null : Math.round(Number(r.client_p50)),
      clientP95: r.client_p95 == null ? null : Math.round(Number(r.client_p95)),
    }));
  }

  /**
   * 已结算消费 SUM（每日限额/成员限额的已结算侧）：usage_logs.amount 按结算时间归属窗口。
   * 含套餐+余额（套餐覆盖的消耗不写 wallet 流水，唯此处能计入「单日总价值消耗」）。
   */
  async sumSettledSpend(
    c: RepoContext,
    dims: { userId?: number; apiKeyId?: number; subscriptionId?: number; since: Date },
  ): Promise<string> {
    const conditions = [sql`status = 0`, sql`created_at >= ${dims.since}`];
    if (dims.userId != null) conditions.push(sql`user_id = ${dims.userId}`);
    if (dims.apiKeyId != null) conditions.push(sql`api_key_id = ${dims.apiKeyId}`);
    if (dims.subscriptionId != null) conditions.push(sql`subscription_id = ${dims.subscriptionId}`);
    const result = await c.db.execute<{ total: string }>(sql`
      select coalesce(sum(amount), 0)::text as total from usage_logs
      where ${sql.join(conditions, sql` and `)}
    `);
    return result.rows[0]?.total ?? '0';
  }

  /**
   * 用户面用量明细（用户隔离硬条件；key/app 来源名左联）：
   * billedBy/planAmount/paygAmount 拆分列直接透出（前端区分套餐/余额展示）。
   */
  async listForUser(
    c: RepoContext,
    input: {
      userId: number;
      limit: number;
      offset: number;
      from?: Date;
      to?: Date;
      model?: string;
    },
  ): Promise<{ rows: UsageRow[]; total: number }> {
    const conditions = [eq(usageLogs.userId, input.userId)];
    if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
    if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
    if (input.model) conditions.push(eq(usageLogs.externalModel, input.model));
    const where = and(...conditions);
    const rows = await c.db
      .select({
        id: usageLogs.id,
        requestId: usageLogs.requestId,
        credentialType: usageLogs.credentialType,
        externalModel: usageLogs.externalModel,
        inputTokens: usageLogs.inputTokens,
        cachedInputTokens: usageLogs.cachedInputTokens,
        outputTokens: usageLogs.outputTokens,
        units: usageLogs.units,
        unitPrice: usageLogs.unitPrice,
        pricingUnit: modelMappings.pricingUnit,
        amount: usageLogs.amount,
        billedBy: usageLogs.billedBy,
        planAmount: usageLogs.planAmount,
        paygAmount: usageLogs.paygAmount,
        durationMs: usageLogs.durationMs,
        clientTtftMs: usageLogs.clientTtftMs,
        stream: usageLogs.stream,
        estimated: usageLogs.estimated,
        createdAt: usageLogs.createdAt,
        keyName: apiKeys.name,
        appName: apps.name,
      })
      .from(usageLogs)
      .leftJoin(modelMappings, eq(usageLogs.externalModel, modelMappings.externalName))
      .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
      .leftJoin(apps, eq(usageLogs.appId, apps.id))
      .where(where)
      .orderBy(desc(usageLogs.id))
      .limit(input.limit)
      .offset(input.offset);
    const [countRow] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(where);
    return { rows, total: countRow?.n ?? 0 };
  }

  /** 按模型聚合（用户隔离；cost 全程字符串——Number() 会 IEEE754 化聚合金额） */
  async aggregateByModel(
    c: RepoContext,
    input: { userId: number; from: Date; to?: Date },
  ): Promise<
    Array<{
      model: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cost: string;
    }>
  > {
    const conditions = [eq(usageLogs.userId, input.userId), gte(usageLogs.createdAt, input.from)];
    if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
    const rows = await c.db
      .select({
        model: usageLogs.externalModel,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
        cost: sql<string>`coalesce(sum(${usageLogs.amount}),0)::text`,
      })
      .from(usageLogs)
      .where(and(...conditions))
      .groupBy(usageLogs.externalModel)
      .orderBy(sql`coalesce(sum(${usageLogs.amount}),0) desc`);
    return rows.map((r) => ({
      model: r.model,
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cachedInputTokens: Number(r.cachedInputTokens),
      cost: r.cost,
    }));
  }

  /** 近 60 秒实时速率（RPM = 请求数，TPM = 输入+输出 token） */
  async rateLastMinute(c: RepoContext, userId: number): Promise<{ rpm: number; tpm: number }> {
    const since = new Date(Date.now() - 60_000);
    const [row] = await c.db
      .select({
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${usageLogs.inputTokens} + ${usageLogs.outputTokens}), 0)::bigint`,
      })
      .from(usageLogs)
      .where(and(eq(usageLogs.userId, userId), gte(usageLogs.createdAt, since)));
    return { rpm: Number(row?.requests ?? 0), tpm: Number(row?.tokens ?? 0) };
  }

  // ── 管理面（运维查询读侧）──────────────────────────────────────────────────

  /** 管理用量列表：q 命中 外部名/真实名/requestId(uuid 转文本)；恒 status=0 已计费 */
  async listAdminUsage(
    c: RepoContext,
    input: {
      q?: string;
      from?: Date;
      to?: Date;
      userId?: number;
      /** 精确模型名（外部名 eq） */
      model?: string;
      estimated?: boolean;
      sortBy: 'id' | 'amount' | 'inputTokens' | 'outputTokens' | 'durationMs' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: unknown[]; total: number }> {
    const conditions = [eq(usageLogs.status, 0)];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(
          ilike(usageLogs.externalModel, pattern),
          ilike(usageLogs.realModel, pattern),
          sql`${usageLogs.requestId}::text ilike ${pattern}`,
        )!,
      );
    }
    if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
    if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
    if (input.userId !== undefined) conditions.push(eq(usageLogs.userId, input.userId));
    if (input.model) conditions.push(eq(usageLogs.externalModel, input.model));
    if (input.estimated !== undefined) conditions.push(eq(usageLogs.estimated, input.estimated));
    const where = and(...conditions);
    const sorts = {
      id: usageLogs.id,
      amount: usageLogs.amount,
      inputTokens: usageLogs.inputTokens,
      outputTokens: usageLogs.outputTokens,
      durationMs: usageLogs.durationMs,
      createdAt: usageLogs.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(usageLogs.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: usageLogs.id,
          requestId: usageLogs.requestId,
          userId: usageLogs.userId,
          userName: users.displayName,
          credentialType: usageLogs.credentialType,
          externalModel: usageLogs.externalModel,
          realModel: usageLogs.realModel,
          inputTokens: usageLogs.inputTokens,
          cachedInputTokens: usageLogs.cachedInputTokens,
          outputTokens: usageLogs.outputTokens,
          units: usageLogs.units,
          unitPrice: usageLogs.unitPrice,
          pricingUnit: modelMappings.pricingUnit,
          amount: usageLogs.amount,
          calculatedAmount: usageLogs.calculatedAmount,
          planAmount: usageLogs.planAmount,
          paygAmount: usageLogs.paygAmount,
          billedBy: usageLogs.billedBy,
          upstreamCost: usageLogs.upstreamCost,
          durationMs: usageLogs.durationMs,
          upstreamTtftMs: usageLogs.upstreamTtftMs,
          clientTtftMs: usageLogs.clientTtftMs,
          stream: usageLogs.stream,
          streamAborted: usageLogs.streamAborted,
          estimated: usageLogs.estimated,
          estimateReason: usageLogs.estimateReason,
          createdAt: usageLogs.createdAt,
        })
        .from(usageLogs)
        .leftJoin(users, eq(usageLogs.userId, users.id))
        .leftJoin(modelMappings, eq(usageLogs.externalModel, modelMappings.externalName))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLogs)
        .leftJoin(users, eq(usageLogs.userId, users.id))
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 请求日志列表：q 命中 path/errorCode/sourceIp/requestId；缺省 30 天窗 */
  async listRequestLogs(
    c: RepoContext,
    input: {
      q?: string;
      from?: Date;
      to?: Date;
      userId?: number;
      /** 数值状态码或 '2xx'/'4xx'/'5xx' 分组 */
      statusCode?: number | '2xx' | '4xx' | '5xx';
      sortBy: 'id' | 'statusCode' | 'durationMs' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
      now: Date;
    },
  ): Promise<{ rows: unknown[]; total: number }> {
    const conditions = [
      gte(requestLogs.createdAt, input.from ?? new Date(input.now.getTime() - 30 * 86_400_000)),
    ];
    if (input.to) conditions.push(lte(requestLogs.createdAt, input.to));
    if (input.userId !== undefined) conditions.push(eq(requestLogs.userId, input.userId));
    if (input.statusCode !== undefined) {
      if (typeof input.statusCode === 'number') {
        conditions.push(eq(requestLogs.statusCode, input.statusCode));
      } else {
        const [lo, hi] =
          input.statusCode === '2xx'
            ? [200, 299]
            : input.statusCode === '4xx'
              ? [400, 499]
              : [500, 599];
        conditions.push(sql`${requestLogs.statusCode} between ${lo} and ${hi}`);
      }
    }
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(
          ilike(requestLogs.path, pattern),
          ilike(requestLogs.errorCode, pattern),
          ilike(requestLogs.sourceIp, pattern),
          sql`${requestLogs.requestId}::text ilike ${pattern}`,
        )!,
      );
    }
    const where = and(...conditions);
    const sorts = {
      id: requestLogs.id,
      statusCode: requestLogs.statusCode,
      durationMs: requestLogs.durationMs,
      createdAt: requestLogs.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(requestLogs.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: requestLogs.id,
          requestId: requestLogs.requestId,
          userId: requestLogs.userId,
          userName: sql<string | null>`coalesce(${users.displayName}, ${users.email})`,
          method: requestLogs.method,
          path: requestLogs.path,
          statusCode: requestLogs.statusCode,
          errorCode: requestLogs.errorCode,
          sourceIp: requestLogs.sourceIp,
          durationMs: requestLogs.durationMs,
          // 请求摘要（model/stream/max_tokens 截断快照）——列表「模型」列的数据源
          requestSummary: requestLogs.requestSummary,
          createdAt: requestLogs.createdAt,
        })
        .from(requestLogs)
        .leftJoin(users, eq(requestLogs.userId, users.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(requestLogs)
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 概览·今日（UTC 起）：请求数/token/消费/成功率（全量行——不筛 status） */
  async statsOverviewToday(
    c: RepoContext,
    since: Date,
  ): Promise<{
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: string;
    successCount: number;
  }> {
    const [row] = await c.db
      .select({
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
        cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
        successCount: sql<number>`count(*) filter (where ${usageLogs.status} = 0)::int`,
      })
      .from(usageLogs)
      .where(gte(usageLogs.createdAt, since));
    return row ?? { requests: 0, inputTokens: 0, outputTokens: 0, cost: '0', successCount: 0 };
  }

  /** 概览·累计：总消费与总请求数 */
  async statsTotals(c: RepoContext): Promise<{ cost: string; requests: number }> {
    const [row] = await c.db
      .select({
        cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageLogs);
    return row ?? { cost: '0', requests: 0 };
  }

  /** 概览·渠道健康：按状态分组的渠道数 */
  async statsChannelHealth(c: RepoContext): Promise<Array<{ status: number; count: number }>> {
    return c.db
      .select({ status: channels.status, count: sql<number>`count(*)::int` })
      .from(channels)
      .groupBy(channels.status)
      .orderBy(asc(channels.status));
  }

  /**
   * 概览·按日趋势（管理台仪表盘折线图数据源）。
   * 日界用北京时间（面板/计价面向中国时区）——UTC 日界会把早 8 点前的量切进昨日。
   * 只带 from 下界（今日子集随时间自然增长，无上界竞态）。
   */
  async statsDailyTrends(
    c: RepoContext,
    from: Date,
  ): Promise<
    Array<{
      date: string;
      requests: number;
      successCount: number;
      inputTokens: number;
      outputTokens: number;
      cost: string;
    }>
  > {
    const day = sql`to_char(${usageLogs.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
    return c.db
      .select({
        date: sql<string>`${day}`,
        requests: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where ${usageLogs.status} = 0)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
        cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
      })
      .from(usageLogs)
      .where(gte(usageLogs.createdAt, from))
      .groupBy(day)
      .orderBy(day);
  }

  /** 用量分组聚合（user/model/channel 三轴；按消费降序） */
  async statsUsageGroups(
    c: RepoContext,
    input: { group: 'user' | 'model' | 'channel'; from?: Date; to?: Date },
  ): Promise<
    Array<{
      key: string | number | null;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cost: string;
      upstreamCost: string;
    }>
  > {
    const conditions = [];
    if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
    if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
    const where = conditions.length ? and(...conditions) : undefined;
    const groupCol =
      input.group === 'user'
        ? usageLogs.userId
        : input.group === 'channel'
          ? usageLogs.channelId
          : usageLogs.externalModel;
    return c.db
      .select({
        key: groupCol,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint`,
        cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
        upstreamCost: sql<string>`coalesce(sum(${usageLogs.upstreamCost}), 0)::numeric::text`,
      })
      .from(usageLogs)
      .where(where)
      .groupBy(groupCol)
      .orderBy(desc(sql`sum(${usageLogs.amount})`))
      .limit(200);
  }

  /** 按日聚合（dashboard 趋势图数据源） */
  async summarizeByDay(
    c: RepoContext,
    input: { userId: number; from?: Date; to?: Date },
  ): Promise<
    Array<{
      date: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cost: string;
    }>
  > {
    const day = sql`to_char(${usageLogs.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
    const conditions = [eq(usageLogs.userId, input.userId)];
    if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
    if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
    const rows = await c.db
      .select({
        date: sql<string>`${day}`,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
        cost: sql<string>`coalesce(sum(${usageLogs.amount}),0)::numeric::text`,
      })
      .from(usageLogs)
      .where(and(...conditions))
      .groupBy(day)
      .orderBy(day);
    // pg int8（bigint 聚合）回传为字符串——与 byModel 同口径映射为 number（前端图表数学）
    return rows.map((row) => ({
      date: row.date,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cachedInputTokens: Number(row.cachedInputTokens),
      cost: row.cost,
    }));
  }
}
