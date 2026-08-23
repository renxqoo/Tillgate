/**
 * API Key 管理面路由（v1 routes/keys.ts 平移）：全量列表 / 限额与状态补丁。
 * status 枚举 0..1;非法 99 → 400。keyPreview 脱敏回显,明文永不回显。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tokenlens/accounts';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { KEY_SORTS, keysContracts } from '../contracts/users';
import { toKeyWireRow } from '../presenters/keys';

export interface KeysRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'adminListKeys' | 'adminPatchKey'>;
}

export function keysRoutes(deps: KeysRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/admin-keys', session, async (c) => {
    const extra = keysContracts.listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), KEY_SORTS, 'createdAt');
    const page = await deps.accounts.adminListKeys({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.userId !== undefined ? { userId: extra.userId } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      sort: query.sortBy,
      order: query.order,
      page: query.page,
      limit: query.limit,
    });
    return c.json(listEnvelope(page.rows.map(toKeyWireRow), page.total, query));
  });

  app.patch('/v1/admin-keys/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = keysContracts.patch.parse(await c.req.json());
    const row = await deps.accounts.adminPatchKey({
      keyId: id,
      patch: body,
      adminId: c.get('adminId'),
    });
    return c.json(toKeyWireRow(row));
  });

  return app;
}
