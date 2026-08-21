/** 凭据动词：注册/幂等重放/占用冲突/并发唯一索引兜底/事务注入回滚/寻址 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../password';
import { identityCredentials } from '../schema';
import { IdentifierTakenError, InvalidInputError } from '../errors';
import { buildFixture, db, nextEmail, nextUserId } from './helpers';

describe('registerCredential', () => {
  it('注册成功落行；重放（同用户同标识）幂等返回同一 credentialId', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    const first = await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email.toUpperCase() },
      passwordHash: await hashPassword('pw-secret-1'),
    });
    expect(first.replayed).toBe(false);
    const replay = await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: email }, // 归一后同标识
    });
    expect(replay.replayed).toBe(true);
    expect(replay.credentialId).toBe(first.credentialId);
    const rows = await db
      .select()
      .from(identityCredentials)
      .where(eq(identityCredentials.identifierValue, email));
    expect(rows).toHaveLength(1);
  });

  it('标识被其他用户占用 → IdentifierTakenError（并发由唯一索引兜底到这里）', async () => {
    const { identity } = buildFixture();
    const email = nextEmail();
    await identity.registerCredential({ userId: nextUserId(), identifier: { kind: 'email', value: email } });
    await expect(
      identity.registerCredential({ userId: nextUserId(), identifier: { kind: 'email', value: email } }),
    ).rejects.toThrow(IdentifierTakenError);
  });

  it('passwordHash 非本包格式 → InvalidInputError（防脏哈希入库导致认证永远失败）', async () => {
    const { identity } = buildFixture();
    await expect(
      identity.registerCredential({
        userId: nextUserId(),
        identifier: { kind: 'email', value: nextEmail() },
        passwordHash: 'plaintext-is-not-a-hash',
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('并发注册同一邮箱（两个用户）：恰好一人成功、一人 IdentifierTaken', async () => {
    const { identity } = buildFixture();
    for (let round = 0; round < 5; round += 1) {
      const email = nextEmail();
      const outcomes = await Promise.allSettled([
        identity.registerCredential({ userId: nextUserId(), identifier: { kind: 'email', value: email } }),
        identity.registerCredential({ userId: nextUserId(), identifier: { kind: 'email', value: email } }),
      ]);
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      const taken = outcomes.filter(
        (o) => o.status === 'rejected' && o.reason instanceof IdentifierTakenError,
      );
      expect(ok).toHaveLength(1);
      expect(taken).toHaveLength(1);
    }
  });

  it('事务注入：随调用方事务回滚（建号+挂凭据同生共死）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await expect(
      db.transaction(async (tx) => {
        await identity.registerCredential({ tx, userId, identifier: { kind: 'email', value: email } });
        throw new Error('caller-abort');
      }),
    ).rejects.toThrow('caller-abort');
    const rows = await db
      .select()
      .from(identityCredentials)
      .where(eq(identityCredentials.identifierValue, email));
    expect(rows).toHaveLength(0);
    // 回滚后同标识可正常注册（幂等键随事务消失）
    const retry = await identity.registerCredential({ userId, identifier: { kind: 'email', value: email } });
    expect(retry.replayed).toBe(false);
  });
});

describe('标识寻址（消费方视角）', () => {
  it('注册后按归一形态可查到唯一凭据行', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const email = nextEmail();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: `  ${email.toUpperCase()}  ` },
    });
    const rows = await db
      .select({ userId: identityCredentials.userId })
      .from(identityCredentials)
      .where(eq(identityCredentials.identifierValue, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
  });
});
