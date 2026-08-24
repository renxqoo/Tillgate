/**
 * 用量路由（会话）：明细（billedBy 拆分）/ 按模型聚合 / 按日汇总（北京时间日桶）/
 * 实时速率。用户隔离在 usage-read 硬绑定（userId 从会话取，不收请求参数）。
 */
import { Hono } from 'hono';
import { query as queryMiddleware } from '@tillgate/http';
import type { MiddlewareHandler } from 'hono';
import { usageListQuerySchema, usageRangeQuerySchema } from '../contracts/usage.js';
import type { UsageWireRow, UsageByModelRow, UsageDayRow } from '../contracts/usage.js';
import type { SessionEnv } from '../middleware/session.js';

export interface UsageReads {
  list(
    userId: number,
    q: { page: number; limit: number; from?: Date; to?: Date; model?: string },
  ): Promise<{ rows: readonly UsageWireRow[]; total: number }>;
  byModel(userId: number, r: { from?: Date; to?: Date }): Promise<readonly UsageByModelRow[]>;
  summary(userId: number, r: { from?: Date; to?: Date }): Promise<{ list: readonly UsageDayRow[] }>;
  rate(userId: number): Promise<{ rpm: number; tpm: number }>;
}

export function usageRoutes(deps: UsageReads, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/usage', session, queryMiddleware(usageListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const result = await deps.list(c.get('userId'), {
      page: query.page,
      limit: query.limit,
      from: query.from != null ? new Date(query.from) : undefined,
      to: query.to != null ? new Date(query.to) : undefined,
      model: query.model,
    });
    return c.json({ rows: result.rows, total: result.total, page: query.page, limit: query.limit });
  });

  app.get('/v1/usage/by-model', session, queryMiddleware(usageRangeQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const rows = await deps.byModel(c.get('userId'), {
      from: query.from != null ? new Date(query.from) : undefined,
      to: query.to != null ? new Date(query.to) : undefined,
    });
    return c.json({ rows });
  });

  app.get('/v1/usage/summary', session, queryMiddleware(usageRangeQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const result = await deps.summary(c.get('userId'), {
      from: query.from != null ? new Date(query.from) : undefined,
      to: query.to != null ? new Date(query.to) : undefined,
    });
    return c.json(result);
  });

  app.get('/v1/usage/rate', session, async (c) => c.json(await deps.rate(c.get('userId'))));

  return app;
}
