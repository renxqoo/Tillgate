/**
 * TOTP 确认:锁外首码匹配 → 锁内 CAS 置 confirmed(步号一并落,防重放)+ 恢复码
 * 整组重签(只存 HMAC 哈希,展示仅此一次)。
 */
import { randomInt } from 'node:crypto';
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { recoveryCodeHashOf } from '../domain/challenge.js';
import { assertUserId } from '../domain/identifier.js';
import { base32Decode, generateRecoveryCode, matchingTotpStep } from '../domain/totp.js';
import type { TotpRow } from '../ports/mfa-store.js';
import { loadedSecret } from './enroll-totp.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export function matchTotp(ctx: IdentityUseCaseContext, row: TotpRow, code: string): number | null {
  return matchingTotpStep(
    base32Decode(loadedSecret(ctx.cipher, row.secret)),
    code,
    ctx.clock.now().getTime(),
    ctx.config.totp.stepSec,
    ctx.config.totp.windowSteps,
  );
}

export async function confirmTotp(
  ctx: IdentityUseCaseContext,
  input: { userId: number; code: string },
): Promise<{ recoveryCodes: string[] }> {
  const userId = assertUserId(input.userId);
  const row = await ctx.mfaStore.loadTotp(ctx.db, userId);
  if (row == null) {
    throw identityErrors.business('totp_not_enrolled', { userId });
  }
  if (row.confirmedAt != null) {
    throw identityErrors.business('totp_already_enrolled', { userId });
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const step = matchTotp(ctx, row, code);
  if (step == null) {
    throw identityErrors.business('invalid_totp_code', { userId });
  }

  const recoveryCodes = Array.from({ length: ctx.config.totp.recoveryCount }, () =>
    generateRecoveryCode((alphabetLen) => randomInt(alphabetLen)),
  );
  const recoveryCodeHashes = recoveryCodes.map((codeText) =>
    recoveryCodeHashOf(codeText, ctx.config.codePepper),
  );

  await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await ctx.mfaStore.confirmEnrollment(tx, {
        userId,
        step,
        recoveryCodeHashes,
      });
      if (outcome.status === 'already_confirmed') {
        throw identityErrors.business('totp_already_enrolled', { userId });
      }
      if (outcome.status === 'not_enrolled') {
        throw identityErrors.business('totp_not_enrolled', { userId });
      }
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: `user:${userId}`,
          action: 'mfa.confirm',
          targetType: 'user',
          targetId: userId,
        }),
      );
    },
    ctx.txRetry,
  );

  return { recoveryCodes };
}
