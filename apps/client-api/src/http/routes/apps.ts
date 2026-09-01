/**
 * Apps 路由（会话）：列表 / 创建（client_secret 仅此一次）/ 禁用 / 轮换密钥。
 */
import { jsonBody, query as queryMiddleware,
  jsonBodyOf,
  queryOf,
  type Middleware, routes } from '@tillgate/http';
import type { AccountUseCases } from '@tillgate/accounts';
import { appCreateSchema, appIdParamSchema, appsListQuerySchema } from '../contracts/apps.js';
import { toAppRow } from '../presenters/keys.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionContext } from '../middleware/session.js';

export interface AppsDeps {
  readonly create: AccountUseCases['createApp'];
  readonly list: AccountUseCases['listApps'];
  readonly disable: AccountUseCases['disableApp'];
  readonly rotateSecret: AccountUseCases['rotateAppSecret'];
}

export function appsRoutes(deps: AppsDeps, session: Middleware<SessionContext>) {
  const app = routes<SessionContext>();

  app.get('/v1/apps', session, queryMiddleware(appsListQuerySchema), async (c) => {
    const query = queryOf(c, appsListQuerySchema);
    const result = await deps.list({
      userId: c.state.userId,
      page: query.page,
      limit: query.limit,
    });
    return c.json({
      rows: result.rows.map(toAppRow),
      total: result.total,
      page: query.page,
      limit: query.limit,
    });
  });

  app.post('/v1/apps', session, jsonBody(appCreateSchema), async (c) => {
    const body = jsonBodyOf(c, appCreateSchema);
    const result = await deps.create({
      userId: c.state.userId,
      name: body.name,
      description: body.description,
      subscriptionId: body.subscriptionId,
      scope: body.scope,
    });
    return c.json({ ...toAppRow(result.app), clientSecret: result.clientSecret }, 201);
  });

  app.post('/v1/apps/:id/disable', session, async (c) => {
    const { id } = parsePath(appIdParamSchema, c.params ?? {});
    const record = await deps.disable({ userId: c.state.userId, appId: id });
    return c.json({ id: record.id });
  });

  app.post('/v1/apps/:id/rotate', session, async (c) => {
    const { id } = parsePath(appIdParamSchema, c.params ?? {});
    const result = await deps.rotateSecret({ userId: c.state.userId, appId: id });
    return c.json({ id: result.app.id, clientSecret: result.clientSecret });
  });

  return app.router;
}
