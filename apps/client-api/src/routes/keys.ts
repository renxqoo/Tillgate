import { Hono } from 'hono';
import { z } from 'zod';
import {
  MONEY_MAX,
  intParam,
  jsonBody,
  listQuerySchema,
  query,
} from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { createMyKey, listMyKeys, revokeMyKey, rotateMyKey, updateMyKey } from '../services/keys.js';

/**
 * 用户面板：虚拟 Key 管理（api-contract §4.2）。
 * 配额锁/订阅归属校验/明文一次性下发在 services/keys.ts；路由只做入参校验与响应。
 */
const keyCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  /** 计费来源：NULL=余额；非空=扣该订阅额度。 */
  subscriptionId: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。 */
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。 */
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

export function keyRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listMyKeys(s, c.get('session').userId, c.req.valid('query'))),
    )
    .post('/', jsonBody(keyCreateSchema), async (c) => {
      const created = await createMyKey(s, c.get('session').userId, c.req.valid('json'));
      return c.json(created, 201);
    })
    .post('/:id/rotate', async (c) => {
      const created = await rotateMyKey(s, c.get('session').userId, intParam(c, 'id'));
      return c.json(created, 201);
    })
    .patch('/:id', jsonBody(keyUpdateSchema), async (c) =>
      c.json(await updateMyKey(s, c.get('session').userId, intParam(c, 'id'), c.req.valid('json'))),
    )
    .delete('/:id', async (c) => {
      await revokeMyKey(s, c.get('session').userId, intParam(c, 'id'));
      return c.json({ ok: true });
    });
}
