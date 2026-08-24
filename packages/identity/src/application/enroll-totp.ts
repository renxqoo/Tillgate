/**
 * TOTP 挂起注册:20 字节 base32 密钥;已确认拒绝;挂起重挂 = 换钥重置 lastUsedStep=-1
 * (扫描了旧二维码的用户必须重新扫)。secret 可经 SecretCipher 加密落库(库内无明文)。
 */
import { randomBytes } from 'node:crypto';
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertUserId } from '../domain/identifier.js';
import { base32Encode } from '../domain/totp.js';
import type { SecretCipher } from '../ports/secret-cipher.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export interface EnrollTotpResult {
  /** base32 明文密钥(仅本次返回,消费方渲染二维码) */
  readonly secret: string;
  readonly otpauthUrl: string;
}

export function storedSecret(cipher: SecretCipher | undefined, plain: string): string {
  return cipher ? cipher.encrypt(plain) : plain;
}

export function loadedSecret(cipher: SecretCipher | undefined, storedValue: string): string {
  return cipher ? cipher.decrypt(storedValue) : storedValue;
}

export async function enrollTotp(
  ctx: IdentityUseCaseContext,
  input: { userId: number; label?: string },
): Promise<EnrollTotpResult> {
  const userId = assertUserId(input.userId);
  const secret = base32Encode(randomBytes(20));

  await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await ctx.mfaStore.upsertEnrollment(tx, {
        userId,
        storedSecret: storedSecret(ctx.cipher, secret),
      });
      if (outcome.status === 'already_confirmed') {
        throw identityErrors.business('totp_already_enrolled', { userId });
      }
      await auditWithinTx(
        tx,
        ctx,
        auditEvent(ctx.clock.now(), {
          actor: `user:${userId}`,
          action: 'mfa.enroll',
          targetType: 'user',
          targetId: userId,
        }),
      );
    },
    ctx.txRetry,
  );
  const label =
    typeof input.label === 'string' && input.label.trim().length > 0
      ? input.label.trim()
      : String(userId);
  const issuer = ctx.config.totp.issuer;
  const otpauthUrl =
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${ctx.config.totp.stepSec}`;
  return { secret, otpauthUrl };
}
