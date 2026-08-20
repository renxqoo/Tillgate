/**
 * API Key 管理面路由（会话）：全量列表（跨用户 q 搜用户邮箱——join 计数）
 * / 限额与状态补丁（status 枚举 0..1；非法 99 → 400）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { KEY_SORTS, type AdminKeysService } from '../services/keys.service.js';
import type { SessionEnv } from '../middleware/session.js';
import { nonNegativeMoneyString } from '../http/money-schema.js';

const listQueryExtra = z.object({
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  dailySpendLimit: nonNegativeMoneyString.nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

export function adminKeysRoutes(service: AdminKeysService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/admin-keys', session, async (c) => {
    const extra = listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), KEY_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), { query, ...extra }));
  });

  app.patch('/v1/admin-keys/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = patchSchema.parse(await c.req.json());
    const { dailySpendLimit, ...rest } = body;
    return c.json(
      await service.patch(adminCtxOf(c), {
        adminId: c.get('adminId'),
        keyId: id,
        patch: {
          ...rest,
          ...(dailySpendLimit !== undefined ? { dailySpendLimit } : {}),
        },
      }),
    );
  });

  return app;
}
