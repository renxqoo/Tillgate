/**
 * 账户资料路由（会话）：GET /v1/me（资料 + 钱包富化）+ PATCH /v1/me/display-name。
 */
import { jsonBody,
  jsonBodyOf,
  type Middleware, routes } from '@tillgate/http';
import type { AccountUseCases } from '@tillgate/accounts';
import type { AccountSnapshot } from '@tillgate/billing';
import { displayNameSchema } from '../contracts/me.js';
import { toMeInfo } from '../presenters/me.js';
import type { SessionContext } from '../middleware/session.js';

export interface MeDeps {
  readonly profile: AccountUseCases['getProfile'];
  readonly updateDisplayName: AccountUseCases['updateDisplayName'];
  readonly walletAccounts: (userId: number) => Promise<readonly AccountSnapshot[]>;
}

export function meRoutes(deps: MeDeps, session: Middleware<SessionContext>) {
  const app = routes<SessionContext>();

  app.get('/v1/me', session, async (c) => {
    const { userId } = c.state;
    const [profile, accounts] = await Promise.all([
      deps.profile(userId),
      deps.walletAccounts(userId),
    ]);
    return c.json(toMeInfo(profile, accounts));
  });

  app.patch('/v1/me/display-name', session, jsonBody(displayNameSchema), async (c) => {
    const body = jsonBodyOf(c, displayNameSchema);
    const user = await deps.updateDisplayName({
      userId: c.state.userId,
      displayName: body.displayName,
    });
    return c.json({ displayName: user.displayName });
  });

  return app.router;
}
