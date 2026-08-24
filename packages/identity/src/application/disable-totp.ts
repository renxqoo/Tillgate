/**
 * 关闭 TOTP:已确认必须先 verifyMfa(否则盗会话者可直关 MFA);挂起态免码直删;
 * 恢复码连带清除。审计 targetId 语义统一(B20 系)。
 */
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertUserId } from '../domain/identifier.js';
import { verifyMfa } from './verify-mfa.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export async function disableTotp(
  ctx: IdentityUseCaseContext,
  input: { userId: number; code?: string },
): Promise<{ disabled: boolean }> {
  const userId = assertUserId(input.userId);
  const row = await ctx.mfaStore.loadTotp(ctx.db, userId);
  if (row == null) {
    throw identityErrors.business('totp_not_enrolled', { userId });
  }
  if (row.confirmedAt != null) {
    if (input.code == null) {
      throw identityErrors.business('invalid_totp_code', { userId });
    }
    await verifyMfa(ctx, { userId, code: input.code });
  }

  await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      await ctx.mfaStore.deleteTotpAndRecoveryCodes(tx, userId);
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: `user:${userId}`,
          action: 'mfa.disable',
          targetType: 'user',
          targetId: userId,
        }),
      );
    },
    ctx.txRetry,
  );

  return { disabled: true };
}
