/** 安全专项：机密不入库（码/恢复码/TOTP 密钥）/输入洪水不炸/配置 fail fast/挑战哈希加盐 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { identityChallenges } from '../schema';
import { hashPassword } from '../password';
import type { ChallengeTarget } from '../types';
import { InvalidCredentialsError, InvalidInputError } from '../errors';
import { buildFixture, db, nextEmail, nextUserId } from './helpers';

describe('机密不落明文', () => {
  it('挑战库内只有加盐哈希：sha256(code:challengeId)，明文码/码表不可反推', async () => {
    const { identity } = buildFixture();
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    const row = (
      await db
        .select({ codeHash: identityChallenges.codeHash, payload: identityChallenges.payload })
        .from(identityChallenges)
        .where(eq(identityChallenges.id, challengeId))
    )[0]!;
    expect(row.codeHash).toBe(createHash('sha256').update(`${code}:${challengeId}`).digest('hex'));
    expect(row.codeHash).not.toContain(code);
    expect(JSON.stringify(row.payload ?? {})).not.toContain(code);
  });
});

describe('输入洪水与畸形输入（不裸炸、不 DoS 自身）', () => {
  it('超长密码串认证 → 正常拒绝（恒定路径），不崩溃', async () => {
    const { identity } = buildFixture();
    const email = nextEmail();
    await identity.registerCredential({
      userId: nextUserId(),
      identifier: { kind: 'email', value: email },
      passwordHash: await hashPassword('normal-password-1'),
    });
    await expect(
      identity.authenticate({ identifier: { kind: 'email', value: email }, password: 'x'.repeat(100_000) }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('标识值含控制字符/注入片段 → 归一化拒绝（参数化查询之外的第二道闸）', async () => {
    const { identity } = buildFixture();
    for (const evil of ['a@b.c; drop table users', 'a\tb@c.com', 'a\nb@c.com', '" OR 1=1 --@x.y']) {
      await expect(
        identity.registerCredential({ userId: nextUserId(), identifier: { kind: 'email', value: evil } }),
      ).rejects.toThrow();
    }
  });

  it('challenge 覆盖参数越界（ttlMs=10 / maxAttempts=0）→ InvalidInputError', async () => {
    const { identity } = buildFixture();
    const target: ChallengeTarget = { identifier: { kind: 'email', value: nextEmail() } };
    await expect(identity.beginChallenge({ kind: 'email_code', target, ttlMs: 10 })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(identity.beginChallenge({ kind: 'email_code', target, maxAttempts: 0 })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(identity.beginChallenge({ kind: 'email_code', target, cooldownMs: -1 })).rejects.toThrow(
      InvalidInputError,
    );
  });
});

describe('配置 fail fast（坏配置不带进运行期）', () => {
  it('空 identifiers / 词表形状非法 / 数值越界 / 重复项 → createIdentity 即抛（同步）', async () => {
    const { createIdentity } = await import('../identity');
    const base = {
      providers: ['github'],
      challenges: ['email_code'],
    };
    expect(() => createIdentity(db, { ...base, identifiers: [] as never })).toThrow(InvalidInputError);
    expect(() =>
      createIdentity(db, { ...base, identifiers: ['email'], providers: ['Bad Provider'] }),
    ).toThrow(InvalidInputError);
    expect(() => createIdentity(db, { ...base, identifiers: ['email'], challenges: ['a', 'a'] })).toThrow(
      InvalidInputError,
    );
    expect(() => createIdentity(db, { ...base, identifiers: ['email'], challenge: { digits: 3 } })).toThrow(
      InvalidInputError,
    );
    expect(() => createIdentity(db, { ...base, identifiers: ['email'], totp: { stepSec: 5 } })).toThrow(
      InvalidInputError,
    );
  });
});
