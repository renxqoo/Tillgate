import { Hono } from 'hono';
import { query, listQuerySchema } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { listPurchasablePlans } from '../services/plans.js';

/**
 * 用户面板：可购套餐列表（api-contract §4.9）。查询在 services/plans.ts。
 */
export function planRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>().get('/', query(listQuerySchema), async (c) =>
    c.json(await listPurchasablePlans(s, c.req.valid('query'))),
  );
}
