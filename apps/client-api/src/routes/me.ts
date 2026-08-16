import { Hono } from 'hono';
import { z } from 'zod';
import { jsonBody, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { getCurrentSubscription, getMe, listMyTransactions, txQuerySchema, updateDisplayName } from '../services/me.js';

/**
 * 用户面板：当前用户信息与资金流水（api-contract §4.1 / §4.3）。
 * 数据与写规则在 services/me.ts；此处只做入参校验与响应塑形。
 */
export function meRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .get('/', async (c) => c.json(await getMe(s, c.get('session').userId)))

    .patch(
      '/display-name',
      jsonBody(z.object({ displayName: z.string().trim().min(1, '请输入显示名称').max(32, '最多 32 个字符') })),
      async (c) => {
        const body = c.req.valid('json');
        const displayName = await updateDisplayName(s, c.get('session').userId, body.displayName);
        return c.json({ ok: true, displayName });
      },
    )

    .get('/subscription', async (c) => c.json(await getCurrentSubscription(s, c.get('session').userId)))

    .get('/transactions', query(txQuerySchema), async (c) =>
      c.json(await listMyTransactions(s, c.get('session').userId, c.req.valid('query'))),
    );
}
