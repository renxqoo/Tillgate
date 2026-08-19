/**
 * 钱包路由（会话）：余额摘要 / 腿级流水（游标分页）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { WalletService } from '../services/wallet.service.js';

const statementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  beforeLegId: z.coerce.number().int().positive().optional(),
});

export function walletRoutes(service: WalletService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/wallet/accounts', session, async (c) => {
    const accounts = await service.accounts(userCtxOf(c), c.get('userId'));
    return c.json({ accounts });
  });

  app.get('/v1/wallet/statement', session, async (c) => {
    const query = statementQuerySchema.parse(c.req.query());
    const rows = await service.statement(userCtxOf(c), { userId: c.get('userId'), ...query });
    // nextCursor = 游标分页续读锚（v1 对位；行数 < limit 即末页）
    const last = rows[rows.length - 1] as { legId?: number; id?: number } | undefined;
    const nextCursor = rows.length >= query.limit && last != null ? String(last.legId ?? last.id ?? '') : null;
    return c.json({ rows, ...(nextCursor ? { nextCursor } : {}) });
  });

  return app;
}
