/**
 * Apps 路由（会话）：列表 / 创建（client_secret 仅此一次）/ 禁用 / 轮换密钥。
 */
import { Hono } from 'hono';
import { jsonBody, query as queryMiddleware } from '@tokenlens/http';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tokenlens/accounts';
import { appCreateSchema, appIdParamSchema, appsListQuerySchema } from '../contracts/apps.js';
import { toAppRow } from '../presenters/keys.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionEnv } from '../middleware/session.js';

export interface AppsDeps {
  readonly create: AccountUseCases['createApp'];
  readonly list: AccountUseCases['listApps'];
  readonly disable: AccountUseCases['disableApp'];
  readonly rotateSecret: AccountUseCases['rotateAppSecret'];
}

export function appsRoutes(deps: AppsDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/apps', session, queryMiddleware(appsListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const result = await deps.list({ userId: c.get('userId'), page: query.page, limit: query.limit });
    return c.json({
      rows: result.rows.map(toAppRow),
      total: result.total,
      page: query.page,
      limit: query.limit,
    });
  });

  app.post('/v1/apps', session, jsonBody(appCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.create({
      userId: c.get('userId'),
      name: body.name,
      description: body.description,
      subscriptionId: body.subscriptionId,
      scope: body.scope,
    });
    return c.json({ ...toAppRow(result.app), clientSecret: result.clientSecret }, 201);
  });

  app.post('/v1/apps/:id/disable', session, async (c) => {
    const { id } = parsePath(appIdParamSchema, c.req.param());
    const record = await deps.disable({ userId: c.get('userId'), appId: id });
    return c.json({ id: record.id });
  });

  app.post('/v1/apps/:id/rotate', session, async (c) => {
    const { id } = parsePath(appIdParamSchema, c.req.param());
    const result = await deps.rotateSecret({ userId: c.get('userId'), appId: id });
    return c.json({ id: result.app.id, clientSecret: result.clientSecret });
  });

  return app;
}
