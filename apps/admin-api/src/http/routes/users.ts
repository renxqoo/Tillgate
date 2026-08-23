/**
 * 用户路由（v1 routes/users.ts 资料面平移）：列表（钱包富化 + 企业过滤）/资料/补丁
 * （封禁语义;creditLimit 拆给 wallet.setCreditLimit——app 组合,非第二套规则）。
 * 响应体永不包含 passwordHash（服务列白名单,测试红线锁定）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tokenlens/accounts';
import type { WalletApi } from '@tokenlens/billing';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { USER_SORTS, usersContracts } from '../contracts/users';
import { toUserWireRow, walletEnrichmentOf } from '../presenters/users';

/** 路由依赖（facade 结构子集——测试注入替身） */
export interface UsersRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'adminListUsers' | 'adminGetUser' | 'adminPatchUser'>;
  readonly wallet: Pick<WalletApi, 'accounts' | 'setCreditLimit'>;
}

export function usersRoutes(deps: UsersRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/users', session, async (c) => {
    const extra = usersContracts.listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), USER_SORTS, 'createdAt');
    const page = await deps.accounts.adminListUsers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.enterprise !== undefined ? { enterprise: extra.enterprise === '1' } : {}),
      sort: query.sortBy,
      order: query.order,
      page: query.page,
      limit: query.limit,
    });
    const rows = await Promise.all(
      page.rows.map(async (row) =>
        toUserWireRow(row, walletEnrichmentOf(await deps.wallet.accounts(row.id))),
      ),
    );
    return c.json(listEnvelope(rows, page.total, query));
  });

  app.get('/v1/users/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const profile = await deps.accounts.adminGetUser(id);
    return c.json(
      toUserWireRow(
        profile,
        walletEnrichmentOf(await deps.wallet.accounts(id)),
        profile.rateCardName,
      ),
    );
  });

  app.patch('/v1/users/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = usersContracts.patch.parse(await c.req.json());
    const { creditLimit, ...patch } = body;
    await deps.accounts.adminPatchUser({
      userId: id,
      patch,
      adminId: c.get('adminId'),
    });
    if (creditLimit !== undefined) {
      await deps.wallet.setCreditLimit({ userId: id, amount: creditLimit });
    }
    return c.json({ id });
  });

  return app;
}
