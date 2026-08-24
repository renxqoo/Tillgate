/**
 * API Key 路由（会话）：列表 / 创建（明文仅此一次返回）/ 修补 / 轮换 / 吊销。
 */
import { Hono } from 'hono';
import { jsonBody, query as queryMiddleware } from '@tillgate/http';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import {
  keyCreateSchema,
  keyIdParamSchema,
  keyPatchSchema,
  keysListQuerySchema,
} from '../contracts/keys.js';
import { toKeyRow } from '../presenters/keys.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionEnv } from '../middleware/session.js';

export interface KeysDeps {
  readonly create: AccountUseCases['createKey'];
  readonly list: AccountUseCases['listKeys'];
  readonly patch: AccountUseCases['patchKey'];
  readonly rotate: AccountUseCases['rotateKey'];
  readonly revoke: AccountUseCases['revokeKey'];
}

export function keysRoutes(deps: KeysDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/keys', session, queryMiddleware(keysListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const result = await deps.list({
      userId: c.get('userId'),
      page: query.page,
      limit: query.limit,
    });
    return c.json({
      rows: result.rows.map(toKeyRow),
      total: result.total,
      page: query.page,
      limit: query.limit,
    });
  });

  app.post('/v1/keys', session, jsonBody(keyCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.create({
      userId: c.get('userId'),
      name: body.name,
      remark: body.remark,
      rpmLimit: body.rpmLimit,
      tpmLimit: body.tpmLimit,
      dailySpendLimit: body.dailySpendLimit,
      expiresAt: body.expiresAt != null ? new Date(body.expiresAt) : null,
      subscriptionId: body.subscriptionId,
    });
    return c.json({ id: result.key.id, name: result.key.name, plaintext: result.plaintext }, 201);
  });

  app.patch('/v1/keys/:id', session, jsonBody(keyPatchSchema), async (c) => {
    const { id } = parsePath(keyIdParamSchema, c.req.param());
    const patch = c.req.valid('json');
    const key = await deps.patch({
      userId: c.get('userId'),
      keyId: id,
      patch: {
        name: patch.name,
        remark: patch.remark,
        rpmLimit: patch.rpmLimit,
        tpmLimit: patch.tpmLimit,
        dailySpendLimit: patch.dailySpendLimit,
        expiresAt: patch.expiresAt != null ? new Date(patch.expiresAt) : null,
      },
    });
    return c.json(toKeyRow(key));
  });

  app.post('/v1/keys/:id/rotate', session, async (c) => {
    const { id } = parsePath(keyIdParamSchema, c.req.param());
    const result = await deps.rotate({ userId: c.get('userId'), keyId: id });
    return c.json({ ...toKeyRow(result.key), plaintext: result.plaintext }, 201);
  });

  app.delete('/v1/keys/:id', session, async (c) => {
    const { id } = parsePath(keyIdParamSchema, c.req.param());
    const key = await deps.revoke({ userId: c.get('userId'), keyId: id });
    return c.json({ id: key.id });
  });

  return app;
}
