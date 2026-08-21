/** MFA 全流程：挂起/确认（防重放步号）/验证（TOTP 单调 CAS + 恢复码单次消费）/关闭/密钥静态加密 */
import { eq } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityRecoveryCodes, identityTotp } from '../schema';
import { base32Decode, totpAt } from '../totp';
import {
  InvalidTotpCodeError,
  TotpAlreadyEnrolledError,
  TotpNotEnrolledError,
} from '../errors';
import { buildFixture, db, nextUserId, type TestFixture } from './helpers';

function codeAt(secret: string, ms: number): string {
  return totpAt(base32Decode(secret), ms);
}

describe('TOTP 注册/确认', () => {
  it('enroll → 挂起态；confirm 首码 → 生效 + 恢复码只此一次（库内只存哈希）', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const { secret, otpauthUrl } = await fx.identity.enrollTotp({ userId, label: 'alice@x.co' });
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl).toContain('issuer=identity');

    const { recoveryCodes } = await fx.identity.confirmTotp({
      userId,
      code: codeAt(secret, fx.clockMs()),
    });
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    }
    const rows = await db
      .select({ codeHash: identityRecoveryCodes.codeHash })
      .from(identityRecoveryCodes)
      .where(eq(identityRecoveryCodes.userId, userId));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(recoveryCodes.includes(row.codeHash)).toBe(false);
    }
  });

  it('confirm 错码 → InvalidTotpCodeError 且仍挂起；已确认再 enroll/confirm → TotpAlreadyEnrolledError', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId });
    await expect(fx.identity.confirmTotp({ userId, code: '000001' })).rejects.toThrow(InvalidTotpCodeError);
    await fx.identity.confirmTotp({ userId, code: codeAt(secret, fx.clockMs()) });
    await expect(fx.identity.enrollTotp({ userId })).rejects.toThrow(TotpAlreadyEnrolledError);
    await expect(
      fx.identity.confirmTotp({ userId, code: codeAt(secret, fx.clockMs()) }),
    ).rejects.toThrow(TotpAlreadyEnrolledError);
  });

  it('挂起态重挂 → 换新密钥（旧密钥的码不再有效）', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const first = await fx.identity.enrollTotp({ userId });
    await fx.identity.confirmTotp({ userId, code: 'wrong-code' }).catch(() => undefined);
    const second = await fx.identity.enrollTotp({ userId });
    expect(second.secret).not.toBe(first.secret);
    await fx.identity.confirmTotp({ userId, code: codeAt(second.secret, fx.clockMs()) });
    await expect(
      fx.identity.confirmTotp({ userId, code: codeAt(first.secret, fx.clockMs()) }),
    ).rejects.toThrow(TotpAlreadyEnrolledError);
  });
});

describe('verifyMfa', () => {
  it('TOTP：confirm 用的码不能重放（步号单调）；下一步的码通过', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId });
    const confirmCode = codeAt(secret, fx.clockMs());
    await fx.identity.confirmTotp({ userId, code: confirmCode });

    await expect(fx.identity.verifyMfa({ userId, code: confirmCode })).rejects.toThrow(InvalidTotpCodeError);
    await expect(fx.identity.verifyMfa({ userId, code: confirmCode })).rejects.toThrow(InvalidTotpCodeError);

    fx.advanceTo(new Date(fx.clockMs() + 31_000));
    const nextCode = codeAt(secret, fx.clockMs());
    await expect(fx.identity.verifyMfa({ userId, code: nextCode })).resolves.toEqual({ method: 'totp' });
    // 新码同样不可重放
    await expect(fx.identity.verifyMfa({ userId, code: nextCode })).rejects.toThrow(InvalidTotpCodeError);
  });

  it('恢复码：单次消费；第二个码仍可用', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId });
    const { recoveryCodes } = await fx.identity.confirmTotp({
      userId,
      code: codeAt(secret, fx.clockMs()),
    });
    await expect(fx.identity.verifyMfa({ userId, code: recoveryCodes[0]! })).resolves.toEqual({
      method: 'recovery',
    });
    await expect(fx.identity.verifyMfa({ userId, code: recoveryCodes[0]! })).rejects.toThrow(InvalidTotpCodeError);
    await expect(fx.identity.verifyMfa({ userId, code: recoveryCodes[1]! })).resolves.toEqual({
      method: 'recovery',
    });
  });

  it('未注册/挂起未确认 → TotpNotEnrolledError；乱码 → InvalidTotpCodeError', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    await expect(fx.identity.verifyMfa({ userId, code: '123456' })).rejects.toThrow(TotpNotEnrolledError);
    const pending = nextUserId();
    await fx.identity.enrollTotp({ userId: pending });
    await expect(fx.identity.verifyMfa({ userId: pending, code: '123456' })).rejects.toThrow(TotpNotEnrolledError);
    const confirmed = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId: confirmed });
    await fx.identity.confirmTotp({ userId: confirmed, code: codeAt(secret, fx.clockMs()) });
    await expect(fx.identity.verifyMfa({ userId: confirmed, code: 'ZZZZZZZZ' })).rejects.toThrow(
      InvalidTotpCodeError,
    );
  });
});

describe('disableTotp', () => {
  it('已确认：必须携有效码；关闭后 MFA 与恢复码全清', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId });
    const { recoveryCodes } = await fx.identity.confirmTotp({
      userId,
      code: codeAt(secret, fx.clockMs()),
    });
    await expect(fx.identity.disableTotp({ userId })).rejects.toThrow(InvalidTotpCodeError);
    expect(await fx.identity.disableTotp({ userId, code: recoveryCodes[0]! })).toEqual({ disabled: true });
    await expect(fx.identity.verifyMfa({ userId, code: '123456' })).rejects.toThrow(TotpNotEnrolledError);
    const codes = await db
      .select({ id: identityRecoveryCodes.id })
      .from(identityRecoveryCodes)
      .where(eq(identityRecoveryCodes.userId, userId));
    expect(codes).toHaveLength(0);
    const again = await fx.identity.enrollTotp({ userId });
    expect(again.secret).not.toBe(secret);
  });

  it('挂起态（未确认）免码直删', async () => {
    const fx = buildFixture();
    const userId = nextUserId();
    await fx.identity.enrollTotp({ userId });
    expect(await fx.identity.disableTotp({ userId })).toEqual({ disabled: true });
    const rows = await db.select().from(identityTotp).where(eq(identityTotp.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

describe('TOTP 密钥静态加密', () => {
  it('配置 SecretCipher 后库内密文 ≠ base32 明文，功能不受影响', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = {
      encrypt: (plain: string): string => {
        const c = createCipheriv('aes-256-gcm', key, iv);
        const body = c.update(plain, 'utf8', 'hex') + c.final('hex');
        return `${body}:${c.getAuthTag().toString('hex')}`;
      },
      decrypt: (stored: string): string => {
        const [body, tag] = stored.split(':');
        const d = createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(Buffer.from(tag!, 'hex'));
        return d.update(body!, 'hex', 'utf8') + d.final('utf8');
      },
    };
    const fx: TestFixture = buildFixture({ totpSecretCipher: cipher });
    const userId = nextUserId();
    const { secret } = await fx.identity.enrollTotp({ userId });
    const row = (
      await db.select({ secret: identityTotp.secret }).from(identityTotp).where(eq(identityTotp.userId, userId))
    )[0]!;
    expect(row.secret).not.toBe(secret);
    expect(row.secret).not.toMatch(/^[A-Z2-7]+$/);
    await fx.identity.confirmTotp({ userId, code: codeAt(secret, fx.clockMs()) });
    fx.advanceTo(new Date(fx.clockMs() + 31_000));
    await expect(fx.identity.verifyMfa({ userId, code: codeAt(secret, fx.clockMs()) })).resolves.toEqual({
      method: 'totp',
    });
  });
});
