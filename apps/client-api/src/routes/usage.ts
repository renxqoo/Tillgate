import { Hono } from 'hono';
import { query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { getUsageRate, listUsage, rangeQuerySchema, usageByModel, usageQuerySchema, usageSummary } from '../services/usage.js';

/**
 * 用户面板：用量查询（api-contract §4.3）。聚合与明细查询在 services/usage.ts。
 */
export function usageRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .get('/rate', async (c) => c.json(await getUsageRate(s, c.get('session').userId)))
    .get('/', query(usageQuerySchema), async (c) =>
      c.json(await listUsage(s, c.get('session').userId, c.req.valid('query'))),
    )
    .get('/summary', query(rangeQuerySchema), async (c) =>
      c.json(await usageSummary(s, c.get('session').userId, c.req.valid('query'))),
    )
    .get('/by-model', query(rangeQuerySchema), async (c) =>
      c.json(await usageByModel(s, c.get('session').userId, c.req.valid('query'))),
    );
}
