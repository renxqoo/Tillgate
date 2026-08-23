/**
 * 观测域契约（v1 tracing.ts + ops.ts audit/logs 子集 zod 面平移）。
 * tracing 参数守卫在存储侧（regex 白名单——防注入）;这里只收口径与长度。
 */
import { z } from 'zod';

export const AUDIT_SORTS = ['id', 'action', 'createdAt'] as const;
export const LOG_SORTS = ['id', 'statusCode', 'durationMs', 'createdAt'] as const;

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

export const tracingContracts = {
  recentQuery: tracingRecentQuerySchema,
} as const;

export const logsContracts = {
  queryExtra: logsQueryExtra,
} as const;
