/** 密码变更动词：changePassword（验旧密+吊销线）/ resetPassword（免旧密+吊销线）/ 弱口令策略 */
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../password';
import { InvalidCredentialsError, WeakPasswordError } from '../errors';
import { buildFixture, nextEmail, nextUserId } from './helpers';

describe('changePassword', () => {
  it('正确旧密 → 换哈希 + 吊销线推进（旧会话失效、新会话有效、新密码可认证）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('old-password-1'),
    });
    const iatBefore = Date.now() - 60_000;
    expect(await identity.sessionValidAt({ userId, iat: iatBefore })).toBe(true);

    const { invalidBefore } = await identity.changePassword({
      userId,
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    });
    expect(typeof invalidBefore).toBe('string');

    expect(
      await identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'old-password-1' }).catch((e: unknown) => e),
    ).toBeInstanceOf(InvalidCredentialsError);
    const ok = await identity.authenticate({
      identifier: { kind: 'email', value: email },
      password: 'new-password-2',
    });
    expect(ok.userId).toBe(userId);
    expect(await identity.sessionValidAt({ userId, iat: iatBefore })).toBe(false);
    expect(await identity.sessionValidAt({ userId, iat: Date.now() + 60_000 })).toBe(true);
  });

  it('旧密错误 → InvalidCredentialsError，哈希与吊销线均不动', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('old-password-1'),
    });
    await expect(
      identity.changePassword({ userId, currentPassword: 'wrong', newPassword: 'new-password-2' }),
    ).rejects.toThrow(InvalidCredentialsError);
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'old-password-1' }),
    ).resolves.toEqual({ userId });
  });

  it('无密码账号（OAuth-only）→ InvalidCredentialsError（设初始密码走 resetPassword）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.registerCredential({ userId, identifier: { kind: 'email', value: nextEmail() } });
    await expect(
      identity.changePassword({ userId, currentPassword: 'any', newPassword: 'new-password-2' }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('新密码不满足策略 → WeakPasswordError，原密码保持可用', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('old-password-1'),
    });
    await expect(
      identity.changePassword({ userId, currentPassword: 'old-password-1', newPassword: 'short' }),
    ).rejects.toThrow(WeakPasswordError);
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'old-password-1' }),
    ).resolves.toEqual({ userId });
  });
});

describe('resetPassword', () => {
  it('免旧密覆盖 + 吊销线推进；对无密码账号等于设置初始密码', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('old-password-1'),
    });
    const staleIat = Date.now();
    await identity.resetPassword({ userId, newPassword: 'reset-password-3' });
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'old-password-1' }),
    ).rejects.toThrow(InvalidCredentialsError);
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'reset-password-3' }),
    ).resolves.toEqual({ userId });
    expect(await identity.sessionValidAt({ userId, iat: staleIat })).toBe(false);

    const fresh = nextUserId();
    const freshEmail = nextEmail();
    await identity.registerCredential({ userId: fresh, identifier: { kind: 'email', value: freshEmail } });
    await identity.resetPassword({ userId: fresh, newPassword: 'brand-new-password' });
    const auth = await identity.authenticate({
      identifier: { kind: 'email', value: freshEmail },
      password: 'brand-new-password',
    });
    expect(auth.userId).toBe(fresh);
  });

  it('弱口令 → WeakPasswordError，旧密码仍可用', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('old-password-1'),
    });
    await expect(identity.resetPassword({ userId, newPassword: 'short' })).rejects.toThrow(WeakPasswordError);
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'old-password-1' }),
    ).resolves.toEqual({ userId });
  });
});
