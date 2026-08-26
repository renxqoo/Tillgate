/**
 * 观测域 OpenAPI registry（routes/{ops-logs,ops-usage,tracing}.ts 契约面）。
 * 请求/查询 schema 引用 contracts/observability.ts;响应 wire 形状在此声明
 * （与 presenters/{observability,ops}.ts 投影逐字段对齐——金额恒十进制字符串）。
 */
import * as z from 'zod';
import {
  logsContracts,
  statsContracts,
  tracingContracts,
  usageContracts,
} from '../contracts/observability';
import { listQuery, paginatedOf, type OpenApiEndpoint } from './shared';

/** 概览响应（今日北京日界 + 累计 + 渠道状态分组） */
export const statsOverviewSchema = z
  .object({
    today: z.object({
      requests: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cost: z.string(),
      successCount: z.number(),
      failedCount: z.number(),
      successRate: z.number(),
    }),
    total: z.object({ cost: z.string(), requests: z.number() }),
    channelHealth: z.array(z.object({ status: z.number(), count: z.number() })),
  })
  .meta({ id: 'StatsOverview', description: '概览响应(GET /v1/stats/overview;今日为北京日界)' });

/** 分组聚合行（user/model/channel 三轴;按消费降序 limit 200） */
export const statsUsageItemSchema = z
  .object({
    key: z.string(),
    requests: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    cost: z.string(),
    upstreamCost: z.string(),
  })
  .meta({
    id: 'StatsUsageItem',
    description: '分组聚合行(GET /v1/stats/usage;group=user/model/channel)',
  });

/** 按日趋势行 */
export const statsTrendRowSchema = z
  .object({
    date: z.string(),
    requests: z.number(),
    successCount: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cost: z.string(),
  })
  .meta({ id: 'StatsTrendRow', description: '按日趋势行(GET /v1/stats/trends;日界为北京时间)' });

/** 按日趋势响应 */
export const statsTrendsSchema = z
  .object({
    days: z.number().describe('回看天数（含今日）'),
    rows: z.array(statsTrendRowSchema),
  })
  .meta({ id: 'StatsTrends', description: '按日趋势响应(GET /v1/stats/trends)' });

/** 请求日志行（attempts/apiKeyId 为 v1 快照口径:v2 presenter 不输出 attempts、apiKeyId 恒 null） */
export const logRowSchema = z
  .object({
    id: z.number(),
    requestId: z.string(),
    userId: z.number(),
    userName: z
      .string()
      .nullable()
      .describe('用户名(displayName 优先,其次 email;LEFT JOIN users,可能为 null)'),
    apiKeyId: z.number().nullable().describe('v2 无来源列,恒 null'),
    method: z.string(),
    path: z.string(),
    statusCode: z.number(),
    errorCode: z.string().nullable(),
    durationMs: z.number(),
    requestSummary: z
      .object({
        model: z.string(),
        stream: z.boolean(),
        max_tokens: z.number(),
        messageCount: z.number(),
      })
      .nullable(),
    attempts: z.number().describe('重试次数(v1 快照口径;v2 presenter 暂不输出——展示兜底为 1 次)'),
    sourceIp: z
      .string()
      .nullable()
      .describe('来源 IP(X-Forwarded-For 首段 / X-Real-IP / socket,鉴权前记录)'),
    createdAt: z.string(),
  })
  .meta({ id: 'LogRow', description: '请求日志行(GET /v1/logs;30 天窗内置)' });

/** 管理端用量明细行（估算扣款一等字段） */
export const adminUsageRowSchema = z
  .object({
    id: z.number(),
    requestId: z.string(),
    userId: z.number(),
    userName: z.string().nullable(),
    credentialType: z.string(),
    externalModel: z.string(),
    realModel: z.string(),
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    outputTokens: z.number(),
    units: z.number().optional().describe('单位计价行(>0 时输入/输出 token 无意义,展示单位用量)'),
    unitPrice: z.string().nullable().optional(),
    pricingUnit: z.string().optional(),
    amount: z.string(),
    calculatedAmount: z.string(),
    planAmount: z.string(),
    paygAmount: z.string(),
    billedBy: z.string(),
    upstreamCost: z.string().nullable(),
    durationMs: z.number(),
    upstreamTtftMs: z.number().nullable().optional(),
    clientTtftMs: z.number().nullable().optional(),
    stream: z.boolean(),
    streamAborted: z.boolean(),
    estimated: z
      .boolean()
      .describe('估算结算标记(2026-08-17 政策):用户取消/完成缺 usage 按估算扣款'),
    estimateReason: z.string().nullable().describe('估算归属(estimated=true 时有值)'),
    createdAt: z.string(),
  })
  .meta({
    id: 'AdminUsageRow',
    description: '管理端用量明细行(GET /v1/usage-logs;恒 status=0 只看已计费行)——估算扣款一等字段',
  });

/** 审计日志行（detail 为 JSON 对象或字符串;adminSubject v2 无 join 来源恒 null） */
export const auditLogRowSchema = z
  .object({
    id: z.number(),
    adminId: z.number().nullable(),
    actor: z.string().nullable(),
    adminSubject: z.string().nullable().describe('管理员标识(v2 无 join 来源,恒 null)'),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    detail: z.union([z.record(z.string(), z.unknown()), z.string()]).nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AuditLogRow', description: '审计日志行(GET /v1/audit-logs)' });

/** trace 摘要行 */
export const traceSummaryRowSchema = z
  .object({
    traceId: z.string(),
    rootName: z.string(),
    startTimeMs: z.number(),
    durationMs: z.number(),
    spanCount: z.number(),
    hasError: z.boolean(),
    services: z.array(z.string()),
    requestId: z.string().nullable(),
  })
  .meta({ id: 'TraceSummaryRow', description: 'trace 摘要行(GET /v1/tracing/recent 列表)。' });

/** span 落库行的 JSON 形态（时间为 ISO 字符串;attributes 为归一化原始键值） */
export const traceSpanRowSchema = z
  .object({
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().nullable(),
    name: z.string(),
    service: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    durationMs: z.number(),
    statusCode: z.number().describe('OTel StatusCode:0=UNSET 1=OK 2=ERROR'),
    statusMessage: z.string().nullable(),
    requestId: z.string().nullable(),
    userId: z.number().nullable(),
    channel: z.string().nullable(),
    model: z.string().nullable(),
    attributes: z.record(z.string(), z.unknown()),
    events: z.array(
      z.object({
        name: z.string(),
        timeMs: z.number(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  .meta({
    id: 'TraceSpanRow',
    description: 'span 落库行的 JSON 形态(时间为 ISO 字符串;attributes 为归一化原始键值)。',
  });

/** trace 详情 */
export const traceDetailDtoSchema = z
  .object({
    spans: z.array(traceSpanRowSchema),
    services: z.array(z.string()),
    startMs: z.number(),
    durationMs: z.number(),
  })
  .meta({
    id: 'TraceDetailDto',
    description: 'trace 详情(GET /v1/tracing/traces/:traceId 与 /by-request/:requestId)。',
  });

/** 渠道健康聚合（topology 行） */
export const channelHealthRowSchema = z
  .object({
    channel: z.string(),
    attempts: z.number(),
    errors: z.number(),
    avgDurationMs: z.number(),
    lastAt: z.number().nullable(),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'ChannelHealthRow', description: '渠道健康聚合(topology 行)。' });

/** topology 响应 */
export const traceTopologyResponseSchema = z
  .object({
    hours: z.number().describe('回看窗口（钳位 1..168）'),
    channels: z.array(channelHealthRowSchema),
  })
  .meta({
    id: 'TraceTopologyResponse',
    description: 'GET /v1/tracing/topology 响应(hours=回看窗口)。',
  });

/** tracing 存储统计响应 */
export const tracingStatsResponseSchema = z
  .object({
    storage: z.object({
      spans: z.number(),
      oldestDays: z.number().nullable(),
      partitions: z.array(z.string()),
    }),
  })
  .meta({ id: 'TracingStatsResponse', description: 'GET /v1/tracing/stats 响应。' });

/** 渠道首字延迟聚合行（双向 P50/P95;延迟取整毫秒） */
const channelTtftRowSchema = z.object({
  channelId: z.number().nullable(),
  channelName: z.string().nullable(),
  samples: z.number(),
  upstreamP50: z.number().nullable(),
  upstreamP95: z.number().nullable(),
  clientP50: z.number().nullable(),
  clientP95: z.number().nullable(),
});

export const observabilityEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/audit-logs',
    tag: 'logs',
    summary: '审计日志列表',
    query: listQuery(),
    response: { schema: paginatedOf(auditLogRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/logs',
    tag: 'logs',
    summary: '请求日志列表（30 天窗;from/to/userId/statusCode 过滤）',
    query: listQuery(logsContracts.queryExtra),
    response: { schema: paginatedOf(logRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/usage-logs',
    tag: 'usage',
    summary: '用量明细列表（恒 status=0;estimated 显式字符串布尔过滤）',
    query: listQuery(usageContracts.queryExtra),
    response: { schema: paginatedOf(adminUsageRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/stats/overview',
    tag: 'stats',
    summary: '概览（今日北京日界 + 累计 + 渠道状态分组）',
    response: { schema: statsOverviewSchema },
    errors: [401],
  },
  {
    method: 'get',
    path: '/v1/stats/usage',
    tag: 'stats',
    summary: '分组聚合（group=user/model/channel,缺省 model）',
    query: statsContracts.usage,
    response: { schema: z.object({ list: z.array(statsUsageItemSchema) }) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/stats/trends',
    tag: 'stats',
    summary: '按日趋势（近 N 天含今日,北京日界;days 钳位 1..90）',
    query: statsContracts.trends,
    response: { schema: statsTrendsSchema },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/analytics/channel-ttft',
    tag: 'stats',
    summary: '渠道首字延迟 P50/P95（hours 容错钳位 1..720,缺省 24）',
    query: z.object({
      hours: z.coerce
        .number()
        .int()
        .optional()
        .describe('回看小时窗（非数/缺省 → 24,越界钳到 [1,720]）'),
    }),
    response: { schema: z.object({ rows: z.array(channelTtftRowSchema) }) },
    errors: [401],
  },
  {
    method: 'get',
    path: '/v1/tracing/recent',
    tag: 'tracing',
    summary: '最近 trace 摘要（service/errorsOnly/minDurationMs/requestId 过滤）',
    query: listQuery(tracingContracts.recentQuery),
    response: { schema: paginatedOf(traceSummaryRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/tracing/traces/:traceId',
    tag: 'tracing',
    summary: '单 trace 瀑布详情',
    params: [
      {
        name: 'traceId',
        description: 'trace id（regex 白名单守卫在存储侧）',
        schema: z.string().min(1).max(64),
      },
    ],
    response: { schema: traceDetailDtoSchema },
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/v1/tracing/by-request/:requestId',
    tag: 'tracing',
    summary: '按 requestId 关联 trace 详情（计费复核入口）',
    params: [{ name: 'requestId', description: '计费请求 id', schema: z.string().min(1).max(64) }],
    response: { schema: traceDetailDtoSchema },
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/v1/tracing/topology',
    tag: 'tracing',
    summary: '渠道健康拓扑（网关 → 各渠道的尝试/错误/延迟聚合）',
    query: z.object({
      hours: z.coerce.number().int().optional().describe('回看小时窗（钳位 1..168,缺省 24）'),
    }),
    response: { schema: traceTopologyResponseSchema },
    errors: [401],
  },
  {
    method: 'get',
    path: '/v1/tracing/stats',
    tag: 'tracing',
    summary: 'trace 存储统计（span 数/最老天数/分区清单）',
    response: { schema: tracingStatsResponseSchema },
    errors: [401],
  },
];
