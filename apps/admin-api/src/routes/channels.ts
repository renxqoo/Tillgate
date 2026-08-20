/**
 * 渠道路由（会话）：列表（富化）/ 创建 / 更新（换 Key 复位运行态）/ 软退役 /
 * 批量导入（best-effort）/ 连通性探针。
 * models 白名单契约 = string[]（逗号串 4xx——转换职责在调用方边界）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { CHANNEL_SORTS, type ChannelsService } from '../services/channels.service.js';
import type { SessionEnv } from '../middleware/session.js';
import { nonNegativeMoneyString } from '../http/money-schema.js';

const createSchema = z.object({
  providerId: z.number().int().positive(),
  name: z.string().min(1, 'name 不能为空').max(64),
  apiKey: z.string().min(1, 'apiKey 不能为空').max(512),
  baseUrlOverride: z.string().max(255).nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().int().min(0).max(1_000_000).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  providerId: z.number().int().positive().optional(),
  status: z.number().int().min(0).max(4).optional(),
  upstreamThreshold: nonNegativeMoneyString.nullable().optional(),
});

const importItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(512),
  models: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  priority: z.number().int().optional(),
});

const importSchema = z.object({
  channels: z.array(importItemSchema).min(1).max(1000),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

export function channelsRoutes(service: ChannelsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/channels', session, async (c) => {
    const query = parseListQuery(c.req.query(), CHANNEL_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.post('/v1/channels', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), { adminId: c.get('adminId'), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/channels/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = updateSchema.parse(await c.req.json());
    // numeric 列以字符串落库（null 透传 = 清阈值）；资金值禁止经过 IEEE-754。
    const { upstreamThreshold, ...rest } = body;
    const patch = {
      ...rest,
      ...(upstreamThreshold !== undefined
        ? { upstreamThreshold }
        : {}),
    };
    return c.json(await service.update(adminCtxOf(c), { adminId: c.get('adminId'), channelId: id, patch }));
  });

  app.delete('/v1/channels/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.retire(adminCtxOf(c), { adminId: c.get('adminId'), channelId: id }));
  });

  app.post('/v1/channels/import', session, async (c) => {
    const body = importSchema.parse(await c.req.json());
    const result = await service.import(adminCtxOf(c), { adminId: c.get('adminId'), channels: body.channels });
    return c.json(result, result.success > 0 ? 200 : 400);
  });

  app.post('/v1/channels/:id/test', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.probe(adminCtxOf(c), id));
  });

  return app;
}
