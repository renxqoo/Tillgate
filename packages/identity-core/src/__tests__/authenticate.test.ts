/** authenticate：统一错误口径（防枚举契约）/ 哑哈希路径 / 脏哈希不炸 */
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../password';
import { identityPasswords } from '../schema';
import { InvalidCredentialsError } from '../errors';
import { buildFixture, db, nextEmail, nextUserId } from './helpers';

describe('authenticate', () => {
  it('正确密码 → 返回 userId；归一形态匹配（大小写/空白）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email.toUpperCase() },
      passwordHash: await hashPassword('right-password-1'),
    });
    const result = await identity.authenticate({
      identifier: { kind: 'email', value: `  ${email}  ` },
      password: 'right-password-1',
    });
    expect(result.userId).toBe(userId);
  });

  it('防枚举契约：未知标识与错误密码抛同一个错误同一个 code', async () => {
    const { identity } = buildFixture();
    const email = nextEmail();
    await identity.registerCredential({
      userId: nextUserId(),
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('known-password'),
    });
    const unknown = await identity
      .authenticate({ identifier: { kind: 'email', value: `no@${Date.now()}.test` }, password: 'x' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as InvalidCredentialsError,
      );
    const wrongPw = await identity
      .authenticate({ identifier: { kind: 'email', value: email }, password: 'x' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as InvalidCredentialsError,
      );
    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect(wrongPw).toBeInstanceOf(InvalidCredentialsError);
    expect(unknown.code).toBe(wrongPw.code);
    expect(unknown.message).toBe(wrongPw.message);
  });

  it('OAuth-only 账号（无密码）认证 → InvalidCredentialsError', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({ userId, identifier: { kind: 'email', value: email } });
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'whatever' }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('库内脏哈希（被篡改/迁移损坏）→ InvalidCredentialsError，不裸炸', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({ userId, identifier: { kind: 'email', value: email } });
    await db
      .insert(identityPasswords)
      .values({ userId, passwordHash: 'not-a-valid-hash' })
      .onConflictDoUpdate({
        target: identityPasswords.userId,
        set: { passwordHash: 'not-a-valid-hash' },
      });
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'x' }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('password 非字符串（null/数字）→ InvalidCredentialsError（统一口径，不 TypeError）', async () => {
    const { identity } = buildFixture();
    const email = nextEmail();
    await identity.registerCredential({
      userId: nextUserId(),
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('pw'),
    });
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: null as never }),
    ).rejects.toThrow(InvalidCredentialsError);
  });
});
