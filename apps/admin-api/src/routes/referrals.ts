/**
 * 邀请管理路由：关系列表（双方邮箱/状态/累计佣金）、作弊封禁/恢复、
 * 三类返利流水（佣金/邀请注册奖励/注册赠送——账本投影，资金单一真相）。
 * 封禁语义：worker 停止派奖（inviterActive 已消费），历史入账不动。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../middleware/session.js';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import type { MarketingService } from '../services/marketing.service.js';

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  return id;
};

const patchSchema = z.object({ status: z.union([z.literal(0), z.literal(1)]) });

export function referralRoutes(service: MarketingService, session: MiddlewareHandler<SessionEnv>): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get('/v1/referrals/relations', session, async (c) => {
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const result = await service.listRelations(adminCtxOf(c), { q: query.q, limit: query.limit, offset: query.offset });
    return c.json({ rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize });
  });

  app.patch('/v1/referrals/relations/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = patchSchema.parse(await c.req.json().catch(() => null));
    return c.json(await service.setRelationStatus(adminCtxOf(c), { adminId: c.get('adminId'), relationId: id, status: body.status }));
  });

  app.get('/v1/referrals/payouts', session, async (c) => {
    const kind = z.enum(['commission', 'referral_signup', 'gift']).parse(c.req.query('kind') ?? '');
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const result = await service.listPayouts(adminCtxOf(c), { kind, limit: query.limit, offset: query.offset });
    return c.json({ rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize });
  });

  return app;
}
