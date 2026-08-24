/**
 * OAuth 绑定:(provider, subject) 防劫持唯一 + (userId, provider) 单绑定;
 * 冲突分类读回定位;同人同 provider 同 subject = 幂等重放。审计同事务写入(§5.4)。
 */
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import {
  assertOAuthSubject,
  assertUserId,
  guardProvider,
  normalizeDisplayEmail,
} from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export interface LinkOAuthResult {
  readonly linkId: number;
  readonly replayed: boolean;
}

export async function linkOAuth(
  ctx: IdentityUseCaseContext,
  input: { userId: number; provider: string; subject: string; email?: string | null },
): Promise<LinkOAuthResult> {
  const provider = guardProvider(input.provider, ctx.guards);
  const subject = assertOAuthSubject(input.subject);
  const userId = assertUserId(input.userId);
  const email = normalizeDisplayEmail(input.email ?? null);

  const result = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await ctx.oauthStore.link(tx, { userId, provider, subject, email });
      if (
        outcome.status === 'provider_identity_taken' ||
        outcome.status === 'user_already_linked'
      ) {
        throw identityErrors.business('provider_already_linked', {
          provider,
          conflict: outcome.status,
        });
      }
      const linked = { linkId: outcome.linkId, replayed: outcome.status === 'replay' };
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: `user:${userId}`,
          action: 'oauth.link',
          targetType: 'oauth_link',
          targetId: linked.linkId,
          detail: { userId, provider, replayed: linked.replayed },
        }),
      );
      return linked;
    },
    ctx.txRetry,
  );

  return result;
}
