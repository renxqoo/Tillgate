import { Hono } from 'hono';
import { z } from 'zod';
import { intParam, jsonBody, listQuerySchema, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { createMyApp, disableMyApp, listMyApps, rotateMyAppSecret } from '../services/apps.js';

/**
 * 用户面板：应用（App）管理（api-contract §4.2）。
 * secret 哈希/配额/缓存失效在 services/apps.ts；明文仅在创建/轮换响应中出现一次。
 */
const appCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  /** 计费来源：NULL=余额；非空=扣该订阅额度。 */
  subscriptionId: z.number().int().positive().nullable().optional(),
  scope: z.object({
    models: z.array(z.string().min(1).max(64)).max(100).optional(),
    rpm: z.number().int().min(1).max(1_000_000).optional(),
    tpm: z.number().int().min(1).max(1_000_000_000).optional(),
  }).optional(),
});

export function appRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listMyApps(s, c.get('session').userId, c.req.valid('query'))),
    )
    .post('/', jsonBody(appCreateSchema), async (c) => {
      const created = await createMyApp(s, c.get('session').userId, c.req.valid('json'));
      return c.json(created, 201);
    })
    .delete('/:id', async (c) => {
      await disableMyApp(s, c.get('session').userId, intParam(c, 'id'));
      return c.json({ ok: true });
    })
    .post('/:id/rotate-secret', async (c) => {
      const clientSecret = await rotateMyAppSecret(s, c.get('session').userId, intParam(c, 'id'));
      return c.json({ ok: true, clientSecret });
    });
}
