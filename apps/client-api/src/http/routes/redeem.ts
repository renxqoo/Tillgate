/**
 * 兑换码路由（会话）：POST /v1/redeem（频率闸在 billing redemption）+ 历史列表。
 */
import { Hono } from 'hono';
import { jsonBody, query as queryMiddleware } from '@tillgate/http';
import type { MiddlewareHandler } from 'hono';
import type { RedemptionApi } from '@tillgate/billing';
import { redeemHistoryQuerySchema, redeemSchema } from '../contracts/billing.js';
import type { SessionEnv } from '../middleware/session.js';

export interface RedeemDeps {
  readonly redeem: RedemptionApi['redeem'];
  readonly history: RedemptionApi['history'];
}

export function redeemRoutes(deps: RedeemDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/redeem', session, jsonBody(redeemSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.redeem(c.get('userId'), { code: body.code });
    return c.json(result);
  });

  app.get('/v1/redeem/history', session, queryMiddleware(redeemHistoryQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const rows = await deps.history(c.get('userId'), { page: query.page, limit: query.limit });
    return c.json({ rows });
  });

  return app;
}
