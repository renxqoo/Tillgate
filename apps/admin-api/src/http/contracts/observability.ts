/**
 * 观测域契约。
 * tracing 参数守卫在存储侧（regex 白名单——防注入）;这里只收口径与长度。
 * usage 排序白名单单一真相 = observability 包 USAGE_SORT_FIELDS（不复制两份）。
 * estimated 是字符串布尔显式解析（'true'/'1' → true——coerce.boolean 会把
 * 'false' 变 true,在 contracts 层收口）。
 */
import * as z from 'zod';
import { USAGE_SORT_FIELDS } from '@tillgate/observability';

export const AUDIT_SORTS = ['id', 'action', 'createdAt'] as const;
export const LOG_SORTS = ['id', 'statusCode', 'durationMs', 'createdAt'] as const;
export const USAGE_SORTS = USAGE_SORT_FIELDS;

const tracingRecentQuerySchema = z.object({
  service: z.string().max(64).optional(),
  errorsOnly: z.enum(['true', '1', 'false', '0']).optional(),
  minDurationMs: z.coerce.number().int().min(0).optional(),
  requestId: z.string().max(64).optional(),
});

const logsQueryExtra = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().positive().optional(),
  /** 数值状态码或 '2xx'/'4xx'/'5xx' 分组 */
  statusCode: z
    .union([z.coerce.number().int().min(100).max(599), z.enum(['2xx', '4xx', '5xx'])])
    .optional(),
});

const usageQueryExtra = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().positive().optional(),
  model: z.string().max(64).optional(),
  /** 'true'/'1' → true;'false'/'0' → false（显式解析,词表外 400） */
  estimated: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
});

export const tracingContracts = {
  recentQuery: tracingRecentQuerySchema,
} as const;

export const logsContracts = {
  queryExtra: logsQueryExtra,
} as const;

export const usageContracts = {
  queryExtra: usageQueryExtra,
} as const;

export const statsContracts = {
  /** 分组聚合:user/model/channel 三轴(model 缺省) */
  usage: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    group: z.enum(['user', 'model', 'channel']).default('model'),
  }),
  /** 按日趋势:近 N 天含今日(北京日界在 observability 包单点) */
  trends: z.object({
    days: z.coerce.number().int().min(1).max(90).default(14),
  }),
} as const;
