/**
 * 链路追踪路由（会话）：recent（含 errorsOnly/service/minDuration/requestId 过滤）/
 * 单 trace 瀑布 / 按RequestId 关联（复核下钻）/ 渠道拓扑 / 存储统计。
 * 参数守卫在 tracing 存储（regex 白名单——防注入与路径滥用）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import type { TracingService } from '../services/tracing.service.js';
import type { SessionEnv } from '../middleware/session.js';

export function tracingRoutes(service: TracingService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/tracing/recent', session, async (c) => {
    const parts = parseListQuery(c.req.query(), ['id'], 'id');
    const raw = c.req.query();
    const errorsOnly = raw.errorsOnly === 'true' || raw.errorsOnly === '1';
    const result = await service.recent({
      service: raw.service?.slice(0, 64) || undefined,
      errorsOnly,
      minDurationMs: raw.minDurationMs ? Math.max(0, Number(raw.minDurationMs) || 0) : undefined,
      requestId: raw.requestId?.slice(0, 64) || undefined,
      limit: parts.limit,
      offset: parts.offset,
    });
    return c.json({ rows: result.rows, total: result.total, page: parts.page, pageSize: parts.pageSize });
  });

  app.get('/v1/tracing/traces/:traceId', session, async (c) => {
    void adminCtxOf(c);
    return c.json(await service.traceDetail(c.req.param('traceId')));
  });

  app.get('/v1/tracing/by-request/:requestId', session, async (c) => {
    void adminCtxOf(c);
    return c.json(await service.byRequest(c.req.param('requestId')));
  });

  app.get('/v1/tracing/topology', session, async (c) => {
    const hours = Math.min(168, Math.max(1, Number(c.req.query('hours')) || 24));
    const channels = await service.topology(hours);
    return c.json({ hours, channels });
  });

  app.get('/v1/tracing/stats', session, async (c) => {
    return c.json({ storage: await service.stats() });
  });

  return app;
}
