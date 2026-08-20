/**
 * API Key 路由（会话）：列表 / 创建（明文仅此一次返回）/ 吊销。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { isValidDailySpendLimitInput } from '../domain/key-limits.js';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { KeysService } from '../services/keys.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  remark: z.string().max(255).optional().nullable(),
  rpmLimit: z.number().int().positive().max(1_000_000).optional().nullable(),
  tpmLimit: z.number().int().positive().max(100_000_000).optional().nullable(),
  // 结构性金额校验：资金输入只收十进制字符串，避免 JSON number 的 IEEE-754 精度损失。
  dailySpendLimit: z
    .string()
    .refine(isValidDailySpendLimitInput, '必须为正金额（过大或格式非法）')
    .optional()
    .nullable(),
  expiresAt: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() > Date.now(), '过期时间必须是未来时点')
    .optional()
    .nullable(),
  /** 计费来源：绑定自己的订阅（或所在组织的订阅） */
  subscriptionId: z.number().int().positive().optional().nullable(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const patchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(100_000_000).nullable().optional(),
  dailySpendLimit: z
    .string()
    .refine(isValidDailySpendLimitInput, '必须为正金额（过大或格式非法）')
    .nullable()
    .optional(),
  expiresAt: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() > Date.now(), '过期时间必须是未来时点')
    .nullable()
    .optional(),
});

export function keysRoutes(service: KeysService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/keys', session, async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const result = await service.list(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows: result.rows, total: result.total, page: query.page, limit: query.limit });
  });

  app.post('/v1/keys', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const result = await service.create(userCtxOf(c), c.get('userId'), body);
    return c.json(result, 201);
  });

  app.patch('/v1/keys/:id', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    const patch = patchSchema.parse(await c.req.json());
    const result = await service.patch(userCtxOf(c), c.get('userId'), id, {
      ...patch,
      expiresAt: patch.expiresAt != null ? new Date(patch.expiresAt) : undefined,
    });
    return c.json(result);
  });

  app.post('/v1/keys/:id/rotate', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    const result = await service.rotate(userCtxOf(c), c.get('userId'), id);
    return c.json(result, 201);
  });

  app.delete('/v1/keys/:id', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    await service.revoke(userCtxOf(c), c.get('userId'), id);
    return c.json({ id });
  });

  return app;
}
