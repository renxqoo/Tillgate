/**
 * 账户资料路由（会话）：GET /v1/me（资料 + 钱包富化）+ PATCH /v1/me/display-name。
 */
import { Hono } from 'hono';
import { jsonBody } from '@tillgate/http';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import type { AccountSnapshot } from '@tillgate/billing';
import { displayNameSchema } from '../contracts/me.js';
import { toMeInfo } from '../presenters/me.js';
import type { SessionEnv } from '../middleware/session.js';

export interface MeDeps {
  readonly profile: AccountUseCases['getProfile'];
  readonly updateDisplayName: AccountUseCases['updateDisplayName'];
  readonly walletAccounts: (userId: number) => Promise<readonly AccountSnapshot[]>;
}

export function meRoutes(deps: MeDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const userId = c.get('userId');
    const [profile, accounts] = await Promise.all([
      deps.profile(userId),
      deps.walletAccounts(userId),
    ]);
    return c.json(toMeInfo(profile, accounts));
  });

  app.patch('/v1/me/display-name', session, jsonBody(displayNameSchema), async (c) => {
    const body = c.req.valid('json');
    const user = await deps.updateDisplayName({
      userId: c.get('userId'),
      displayName: body.displayName,
    });
    return c.json({ displayName: user.displayName });
  });

  return app;
}
