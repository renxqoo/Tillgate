/**
 * 链路追踪路由（v1 routes/tracing.ts 平移）：recent（errorsOnly/service/
 * minDuration/requestId 过滤）/单 trace 瀑布/按 requestId 关联/渠道拓扑/存储统计。
 * 参数守卫在 tracing 存储（regex 白名单——防注入;observability S1 信封承接）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Observability } from '@tokenlens/observability';
import type { SessionEnv } from '../middleware/session';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { tracingContracts } from '../contracts/observability';

export interface TracingRoutesDeps {
  readonly observability: Pick<Observability, 'traces'>;
}

export function tracingRoutes(deps: TracingRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  const traces = deps.observability.traces;

  app.get('/v1/tracing/recent', session, async (c) => {
    const parts = parseListQuery(c.req.query(), ['id'], 'id');
    const raw = tracingContracts.recentQuery.parse(c.req.query());
    const result = await traces.recent({
      ...(raw.service !== undefined && raw.service !== '' ? { service: raw.service } : {}),
      errorsOnly: raw.errorsOnly === 'true' || raw.errorsOnly === '1',
      ...(raw.minDurationMs !== undefined ? { minDurationMs: raw.minDurationMs } : {}),
      ...(raw.requestId !== undefined && raw.requestId !== '' ? { requestId: raw.requestId } : {}),
      limit: parts.limit,
      offset: parts.offset,
    });
    return c.json(listEnvelope(result.rows, result.total, parts));
  });

  app.get('/v1/tracing/traces/:traceId', session, async (c) =>
    c.json(await traces.traceDetail(c.req.param('traceId'))),
  );

  app.get('/v1/tracing/by-request/:requestId', session, async (c) =>
    c.json(await traces.byRequest(c.req.param('requestId'))),
  );

  app.get('/v1/tracing/topology', session, async (c) => {
    // hours 钳位 1..168（存储侧同钳——双重钳位无害;v1 语义）
    const hours = Math.min(168, Math.max(1, Number(c.req.query('hours')) || 24));
    const channels = await traces.topology(hours);
    return c.json({ hours, channels });
  });

  app.get('/v1/tracing/stats', session, async (c) => c.json({ storage: await traces.stats() }));

  return app;
}
