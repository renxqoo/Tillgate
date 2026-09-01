/**
 * 兑换码路由（会话）：POST /v1/redeem（频率闸在 billing redemption）+ 历史列表。
 */
import {
  jsonBody,
  query as queryMiddleware,
  jsonBodyOf,
  queryOf,
  type Middleware,
  routes,
} from '@tillgate/http';
import type { RedemptionApi } from '@tillgate/billing';
import { redeemHistoryQuerySchema, redeemSchema } from '../contracts/billing.js';
import type { SessionContext } from '../middleware/session.js';

export interface RedeemDeps {
  readonly redeem: RedemptionApi['redeem'];
  readonly history: RedemptionApi['history'];
}

export function redeemRoutes(deps: RedeemDeps, session: Middleware<SessionContext>) {
  const app = routes<SessionContext>();

  app.post('/v1/redeem', session, jsonBody(redeemSchema), async (c) => {
    const body = jsonBodyOf(c, redeemSchema);
    const result = await deps.redeem(c.state.userId, { code: body.code });
    return c.json(result);
  });

  app.get('/v1/redeem/history', session, queryMiddleware(redeemHistoryQuerySchema), async (c) => {
    const query = queryOf(c, redeemHistoryQuerySchema);
    const rows = await deps.history(c.state.userId, { page: query.page, limit: query.limit });
    return c.json({ rows });
  });

  return app.router;
}
