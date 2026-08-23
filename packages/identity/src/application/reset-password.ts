/**
 * 重置密码(找回/管理员):免旧密,同样推进吊销线(重置即该 realm 全网下线);
 * 弱口令拒绝时旧密码保持(策略先于事务)。可给 OAuth-only 账号设初始密码。
 */
import { advisoryLock, runTx } from '@tokenlens/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { assertPasswordPolicy, hashPassword } from '../domain/password.js';
import { assertUserId, guardRealm } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { emitAudit } from './context.js';

export interface ResetPasswordInput {
  readonly userId: number;
  readonly realm: string;
  readonly newPassword: string;
}

export async function resetPassword(
  ctx: IdentityUseCaseContext,
  input: ResetPasswordInput,
): Promise<{ invalidBefore: string }> {
  const userId = assertUserId(input.userId);
  const realm = guardRealm(input.realm, ctx.guards);
  assertPasswordPolicy(input.newPassword, ctx.config.passwordPolicy);
  const newHash = await hashPassword(input.newPassword);

  const invalidBefore = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      await ctx.credentialStore.resetPassword(tx, { userId, passwordHash: newHash });
      return ctx.anchorStore.advanceAnchor(tx, { realm, userId });
    },
    ctx.txRetry,
  );

  await emitAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'admin',
      action: 'password.reset',
      targetType: 'user',
      targetId: userId,
      detail: { realm },
    }),
  );
  return { invalidBefore };
}
