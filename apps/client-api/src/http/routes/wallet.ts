/**
 * 钱包路由（会话）：余额摘要 / 腿级流水（游标分页，nextCursor = 满页时的续读锚）。
 */
import { query as queryMiddleware,
  queryOf,
  type Middleware, routes } from '@tillgate/http';
import type { AccountSnapshot, StatementItemView, WalletApi } from '@tillgate/billing';
import { statementQuerySchema } from '../contracts/billing.js';
import type { SessionContext } from '../middleware/session.js';

export interface WalletDeps {
  readonly accounts: WalletApi['accounts'];
  readonly statement: WalletApi['statement'];
}

export function walletRoutes(deps: WalletDeps, session: Middleware<SessionContext>) {
  const app = routes<SessionContext>();

  app.get('/v1/wallet/accounts', session, async (c) => {
    const accounts: readonly AccountSnapshot[] = await deps.accounts(c.state.userId);
    return c.json({ accounts });
  });

  app.get('/v1/wallet/statement', session, queryMiddleware(statementQuerySchema), async (c) => {
    const query = queryOf(c, statementQuerySchema);
    const rows: readonly StatementItemView[] = await deps.statement({
      userId: c.state.userId,
      limit: query.limit,
      beforeLegId: query.beforeLegId,
    });
    const last = rows.at(-1);
    const nextCursor = rows.length >= query.limit && last != null ? String(last.legId) : null;
    return c.json({ rows, ...(nextCursor != null ? { nextCursor } : {}) });
  });

  return app.router;
}
