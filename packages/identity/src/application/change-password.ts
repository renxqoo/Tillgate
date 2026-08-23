/**
 * 改密码:验旧密 → 换哈希 + 吊销线推进(同一事务)。B04 修复:验旧密收进
 * advisoryLock 临界区——旧密的读与改之间不存在并发 reset 覆盖窗口(scrypt 在
 * 每用户锁内执行,无全局争用)。无密码账号(OAuth-only)走 reset。
 */
import { advisoryLock, runTx } from '@tokenlens/db';
import { DefectError } from '@tokenlens/errors';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../domain/password.js';
import { assertUserId, guardRealm } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { emitAudit } from './context.js';

export interface ChangePasswordInput {
  readonly userId: number;
  /** 吊销线推进的 realm(改哪面密码下哪面的线,v1 固定 user 的口径修正) */
  readonly realm: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export async function changePassword(
  ctx: IdentityUseCaseContext,
  input: ChangePasswordInput,
): Promise<{ invalidBefore: string }> {
  const userId = assertUserId(input.userId);
  const realm = guardRealm(input.realm, ctx.guards);
  assertPasswordPolicy(input.newPassword, ctx.config.passwordPolicy);
  if (typeof input.currentPassword !== 'string') {
    throw identityErrors.business('invalid_credentials', { realm });
  }
  const newHash = await hashPassword(input.newPassword);

  const invalidBefore = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const stored = await ctx.credentialStore.loadPasswordHash(tx, userId);
      if (stored == null) {
        throw identityErrors.business('invalid_credentials', { realm });
      }
      const currentOk = await verifyPassword(input.currentPassword, stored);
      if (!currentOk) {
        throw identityErrors.business('invalid_credentials', { realm });
      }
      const updated = await ctx.credentialStore.updatePassword(tx, {
        userId,
        passwordHash: newHash,
      });
      if (!updated) {
        throw new DefectError('password row disappeared mid-transaction', 'identity.defect', {
          operation: 'change_password',
        });
      }
      return ctx.anchorStore.advanceAnchor(tx, { realm, userId });
    },
    ctx.txRetry,
  );

  await emitAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: `user:${userId}`,
      action: 'password.change',
      targetType: 'user',
      targetId: userId,
      detail: { realm },
    }),
  );
  return { invalidBefore };
}
