/**
 * 重置密码(找回/管理员):免旧密,同样推进吊销线(重置即该 realm 全网下线);
 * 弱口令拒绝时旧密码保持(策略先于事务)。可给 OAuth-only 账号设初始密码。
 */
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { assertPasswordPolicy, hashPassword } from '../domain/password.js';
import { assertUserId, guardRealm } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

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
      // 同 change-password：锚线用应用时钟，避免跨时钟域误杀重置后重签的会话
      const before = await ctx.anchorStore.advanceAnchor(tx, {
        realm,
        userId,
        at: ctx.clock.now(),
      });
      // 安全审计同事务写入:回滚即无审计行,写入失败随事务回滚
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: 'admin',
          action: 'password.reset',
          targetType: 'user',
          targetId: userId,
          detail: { realm },
        }),
      );
      return before;
    },
    ctx.txRetry,
  );

  return { invalidBefore };
}
