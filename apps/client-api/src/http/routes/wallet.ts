/**
 * 钱包路由（会话）：余额摘要 / 腿级流水（游标分页，nextCursor = 满页时的续读锚）。
 */
import { Hono } from 'hono';
import { query as queryMiddleware } from '@tokenlens/http';
import type { MiddlewareHandler } from 'hono';
import type { AccountSnapshot, StatementItemView, WalletApi } from '@tokenlens/billing';
import { statementQuerySchema } from '../contracts/billing.js';
import type { SessionEnv } from '../middleware/session.js';

export interface WalletDeps {
  readonly accounts: WalletApi['accounts'];
  readonly statement: WalletApi['statement'];
}

export function walletRoutes(deps: WalletDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/wallet/accounts', session, async (c) => {
    const accounts: readonly AccountSnapshot[] = await deps.accounts(c.get('userId'));
    return c.json({ accounts });
  });

  app.get('/v1/wallet/statement', session, queryMiddleware(statementQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const rows: readonly StatementItemView[] = await deps.statement({
      userId: c.get('userId'),
      limit: query.limit,
      beforeLegId: query.beforeLegId,
    });
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length >= query.limit && last != null ? String(last.legId) : null;
    return c.json({ rows, ...(nextCursor != null ? { nextCursor } : {}) });
  });

  return app;
}
