/** OAuth 解绑:锁内最后凭据守卫(删后必须仍留登录方式);审计 targetId = linkId(B20) */
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertUserId, guardProvider } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export async function unlinkOAuth(
  ctx: IdentityUseCaseContext,
  input: { userId: number; provider: string },
): Promise<{ unlinked: boolean; linkId: number }> {
  const provider = guardProvider(input.provider, ctx.guards);
  const userId = assertUserId(input.userId);

  const result = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await ctx.oauthStore.unlink(tx, { userId, provider });
      if (outcome.status === 'not_found') {
        throw identityErrors.business('oauth_link_not_found', { userId, provider });
      }
      if (outcome.status === 'last_credential') {
        throw identityErrors.business('last_credential', { userId, provider });
      }
      const removed = { unlinked: true as const, linkId: outcome.linkId };
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: `user:${userId}`,
          action: 'oauth.unlink',
          targetType: 'oauth_link',
          targetId: removed.linkId,
          detail: { userId, provider },
        }),
      );
      return removed;
    },
    ctx.txRetry,
  );

  return result;
}
