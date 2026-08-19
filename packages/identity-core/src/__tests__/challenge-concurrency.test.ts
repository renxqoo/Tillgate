/** 挑战并发语义：单次消费 CAS / 同目标并行发码串行化 / 异目标互不干扰 */
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { identityChallenges } from '../schema';
import { ChallengeInvalidError } from '../errors';
import { buildFixture, db, nextEmail } from './helpers';

describe('并发验码（单次消费）', () => {
  it('同一挑战同一码并发验证 N 次：恰好一次成功，其余 ChallengeInvalidError', async () => {
    const { identity } = buildFixture();
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => identity.verifyChallenge({ challengeId, code })),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const invalid = outcomes.filter(
      (o) => o.status === 'rejected' && o.reason instanceof ChallengeInvalidError,
    );
    expect(ok).toHaveLength(1);
    expect(invalid).toHaveLength(5);
  });

  it('并发「一错一对」竞争：最终要么消费成功要么挑战死——attempts 永不越界', async () => {
    const { identity } = buildFixture();
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
      maxAttempts: 2,
    });
    const outcomes = await Promise.allSettled([
      identity.verifyChallenge({ challengeId, code: '000000' }),
      identity.verifyChallenge({ challengeId, code: '000000' }),
      identity.verifyChallenge({ challengeId, code }),
    ]);
    const row = (
      await db
        .select({ attempts: identityChallenges.attempts, maxAttempts: identityChallenges.maxAttempts, consumedAt: identityChallenges.consumedAt })
        .from(identityChallenges)
        .where(eq(identityChallenges.id, challengeId))
    )[0]!;
    expect(row.attempts).toBeLessThanOrEqual(row.maxAttempts);
    if (row.consumedAt == null) {
      // 两次错码耗尽：挑战死亡，任何结果都是拒绝
      expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    }
  });
});

describe('并发发码（同目标串行化）', () => {
  it('cooldownMs=0 并行发码 N 次：全部成功（替换语义），终态恰一条活挑战', async () => {
    const { identity } = buildFixture({ challenge: { cooldownMs: 0 } });
    const email = nextEmail();
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        identity.beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } }),
      ),
    );
    expect(outcomes).toHaveLength(4);
    const live = await db
      .select({ id: identityChallenges.id })
      .from(identityChallenges)
      .where(
        and(
          eq(identityChallenges.identifierValue, email),
          eq(identityChallenges.kind, 'email_code'),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
        ),
      );
    expect(live).toHaveLength(1);
    // 最后活着的挑战可验证成功
    const winner = outcomes.find((o) => o.challengeId === live[0]!.id)!;
    await expect(
      identity.verifyChallenge({ challengeId: winner.challengeId, code: winner.code }),
    ).resolves.toBeTruthy();
  });

  it('冷却期内并行发码：至多一个成功，其余 Cooldown（advisory lock 串行判定）', async () => {
    const { identity } = buildFixture(); // 默认 60s 冷却
    const email = nextEmail();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        identity.beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    expect(ok).toHaveLength(1);
  });

  it('不同目标并行发码互不干扰（5 用户同时收码）', async () => {
    const { identity, delivered } = buildFixture();
    const emails = Array.from({ length: 5 }, () => nextEmail());
    const outcomes = await Promise.all(
      emails.map((email) =>
        identity.beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } }),
      ),
    );
    expect(outcomes.every((o) => o.code.match(/^[0-9]{6}$/))).toBe(true);
    expect(new Set(delivered.map((d) => d.to)).size).toBe(5);
    for (const o of outcomes) {
      await expect(identity.verifyChallenge({ challengeId: o.challengeId, code: o.code })).resolves.toBeTruthy();
    }
  });
});
