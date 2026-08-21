/**
 * 运维查询路由族（会话）：用量明细 / 请求日志 / 全局审计 / 支付订单（含手动关单）/
 * 生成任务 / 统计概览与分组。estimated 是字符串布尔显式解析（防 coerce 陷阱）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import {
  USAGE_SORTS,
  LOG_SORTS,
  AUDIT_SORTS,
  ORDER_SORTS,
  parseEstimated,
  type OpsLogsService,
} from '../services/ops-logs.service.js';
import type { SessionEnv } from '../middleware/session.js';

const dateTime = z.string().datetime();
const optionalDate = dateTime.optional().transform((v) => (v ? new Date(v) : undefined));

const usageQueryExtra = z.object({
  from: optionalDate,
  to: optionalDate,
  userId: z.coerce.number().int().positive().optional(),
  model: z.string().max(64).optional(),
  /** 'true'/'1' → true（显式解析——coerce.boolean 会把 'false' 变 true） */
  estimated: z.enum(['true', 'false', '1', '0']).optional(),
});

const logQueryExtra = z.object({
  from: optionalDate,
  to: optionalDate,
  userId: z.coerce.number().int().positive().optional(),
  statusCode: z
    .union([z.coerce.number().int().min(100).max(599), z.enum(['2xx', '4xx', '5xx'])])
    .optional(),
});

const tasksQuery = z.object({
  kind: z.enum(['video', 'music']).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const statsUsageQuery = z.object({
  from: optionalDate,
  to: optionalDate,
  group: z.enum(['user', 'model', 'channel']).default('model'),
});

const statsTrendsQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
});

const orderParam = (raw: string): string => {
  if (!/^[0-9a-f-]{16,64}$/.test(raw)) {
    throw new AppError(400, 'invalid_param', 'Order id must be a uuid');
  }
  return raw;
};

export function opsRoutes(service: OpsLogsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/usage-logs', session, async (c) => {
    const extra = usageQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), USAGE_SORTS, 'createdAt');
    return c.json(
      await service.usageLogs(adminCtxOf(c), {
        query,
        ...extra,
        estimated: parseEstimated(extra.estimated),
      }),
    );
  });

  app.get('/v1/logs', session, async (c) => {
    const extra = logQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), LOG_SORTS, 'createdAt');
    return c.json(await service.requestLogs(adminCtxOf(c), { query, ...extra }));
  });

  app.get('/v1/audit-logs', session, async (c) => {
    const query = parseListQuery(c.req.query(), AUDIT_SORTS, 'createdAt');
    return c.json(await service.auditLogs(adminCtxOf(c), query));
  });

  app.get('/v1/payment-orders', session, async (c) => {
    const query = parseListQuery(c.req.query(), ORDER_SORTS, 'createdAt');
    return c.json(await service.paymentOrders(adminCtxOf(c), { query }));
  });

  app.post('/v1/payment-orders/:id/close', session, async (c) => {
    const orderId = orderParam(c.req.param('id'));
    return c.json(
      await service.closePaymentOrder(adminCtxOf(c), { adminId: c.get('adminId'), orderId }),
    );
  });

  app.get('/v1/generation-tasks', session, async (c) => {
    const query = tasksQuery.parse(c.req.query());
    return c.json(await service.generationTasks(adminCtxOf(c), query));
  });

  app.get('/v1/stats/overview', session, async (c) => {
    return c.json(await service.statsOverview(adminCtxOf(c)));
  });

  app.get('/v1/analytics/channel-ttft', session, async (c) => {
    const hours = Math.min(720, Math.max(1, Number(c.req.query('hours')) || 24));
    return c.json(await service.channelTtft(adminCtxOf(c), { hours }));
  });

  app.get('/v1/stats/usage', session, async (c) => {
    const query = statsUsageQuery.parse(c.req.query());
    return c.json(await service.statsUsage(adminCtxOf(c), query));
  });

  app.get('/v1/stats/trends', session, async (c) => {
    const query = statsTrendsQuery.parse(c.req.query());
    return c.json(await service.statsTrends(adminCtxOf(c), query));
  });

  return app;
}
