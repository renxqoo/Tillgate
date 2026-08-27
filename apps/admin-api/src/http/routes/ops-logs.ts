/**
 * 运营日志路由：审计列表/请求日志列表。
 * 请求日志 30 天窗由 observability 查询内置（now 注入）。
 */
import { Hono } from 'hono';
import type { Observability } from '@tillgate/observability';
import type { SessionEnv } from '../middleware/session';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { AUDIT_SORTS, LOG_SORTS, logsContracts } from '../contracts/observability';
import { toAuditWireRow, toRequestLogWireRow } from '../presenters/observability';

export interface OpsLogsRoutesDeps {
  readonly observability: Pick<Observability, 'audit' | 'requestLogs'>;
  /** 时钟注入（30 天窗与时间过滤口径;测试替身可冻结） */
  readonly now: () => Date;
}

export function opsLogsRoutes(deps: OpsLogsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/audit-logs', async (c) => {
    const query = parseListQuery(c.req.query(), AUDIT_SORTS, 'createdAt');
    const result = await deps.observability.audit.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'action' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toAuditWireRow), result.total, query));
  });

  app.get('/v1/logs', async (c) => {
    const extra = logsContracts.queryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), LOG_SORTS, 'createdAt');
    const result = await deps.observability.requestLogs.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.from !== undefined ? { from: new Date(extra.from) } : {}),
      ...(extra.to !== undefined ? { to: new Date(extra.to) } : {}),
      ...(extra.userId !== undefined ? { userId: extra.userId } : {}),
      ...(extra.statusCode !== undefined ? { statusCode: extra.statusCode } : {}),
      sortBy: query.sortBy as 'id' | 'statusCode' | 'durationMs' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
      now: deps.now(),
    });
    return c.json(listEnvelope(result.rows.map(toRequestLogWireRow), result.total, query));
  });

  return app;
}
