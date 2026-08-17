/** 挑战生命周期：发码/验证/一次性消费/错次封顶/过期/作废/冷却/替换/投递失败回滚/目标寻址 */
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { identityChallenges } from '../schema';
import {
  ChallengeCooldownError,
  ChallengeInvalidError,
  CodeInvalidError,
  DeliveryFailedError,
  InvalidInputError,
  UndeliverableChallengeError,
  UnknownChallengeKindError,
} from '../errors';
import { buildFixture, db, nextEmail, nextUserId, sleep } from './helpers';

describe('beginChallenge / verifyChallenge 基本流', () => {
  it('发码：6 位码经 deliver 出境（channel/to/kind 齐全）；验码返回目标与载荷', async () => {
    const { identity, delivered } = buildFixture();
    const email = nextEmail();
    const { challengeId, code, channel, to } = await identity.beginChallenge({
      kind: 'email_verification',
      target: { identifier: { kind: 'email', value: email } },
      payload: { passwordHash: 'scrypt:32768:8:1:aa:bb' },
    });
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(channel).toBe('email');
    expect(to).toBe(email);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ channel: 'email', to: email, kind: 'email_verification', code });

    const verified = await identity.verifyChallenge({ challengeId, code });
    expect(verified.target).toEqual({ identifier: { kind: 'email', value: email }, userId: null });
    expect(verified.payload).toEqual({ passwordHash: 'scrypt:32768:8:1:aa:bb' });
  });

  it('一次性消费：第二次验同一码 → ChallengeInvalidError（统一口径）', async () => {
    const { identity } = buildFixture();
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    await identity.verifyChallenge({ challengeId, code });
    await expect(identity.verifyChallenge({ challengeId, code })).rejects.toThrow(ChallengeInvalidError);
  });

  it('错码 → CodeInvalidError（remainingAttempts 递减到 0）；耗尽后挑战死 → ChallengeInvalidError', async () => {
    const { identity } = buildFixture();
    const { challengeId } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    // 5 次错码全部走 CodeInvalid（第 5 次耗尽预算，remaining=0）
    for (let remaining = 4; remaining >= 0; remaining -= 1) {
      const error = await identity
        .verifyChallenge({ challengeId, code: '000000' })
        .then(
          () => {
            throw new Error('expected rejection');
          },
          (e: unknown) => e as CodeInvalidError,
        );
      expect(error).toBeInstanceOf(CodeInvalidError);
      expect(error.remainingAttempts).toBe(remaining);
    }
    // 耗尽后（即使拿到正确码）挑战已死
    await expect(identity.verifyChallenge({ challengeId, code: '000000' })).rejects.toThrow(
      ChallengeInvalidError,
    );
    const live = await db
      .select({ attempts: identityChallenges.attempts })
      .from(identityChallenges)
      .where(eq(identityChallenges.id, challengeId));
    expect(live[0]!.attempts).toBe(5);
  });

  it('过期 → ChallengeInvalidError（ttlMs 边界=1s 档实测）', async () => {
    const { identity } = buildFixture({ challenge: { ttlMs: 1_000 } });
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    await sleep(1_250);
    await expect(identity.verifyChallenge({ challengeId, code })).rejects.toThrow(ChallengeInvalidError);
  });

  it('作废：abort 后验码 → ChallengeInvalidError；重复 abort 幂等返回 false', async () => {
    const { identity } = buildFixture();
    const { challengeId, code } = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    expect(await identity.abortChallenge({ challengeId })).toEqual({ aborted: true });
    expect(await identity.abortChallenge({ challengeId })).toEqual({ aborted: false });
    await expect(identity.verifyChallenge({ challengeId, code })).rejects.toThrow(ChallengeInvalidError);
    // 已消费的挑战不能被 abort（终态互斥）
    const second = await identity.beginChallenge({
      kind: 'password_reset',
      target: { identifier: { kind: 'email', value: nextEmail() } },
    });
    await identity.verifyChallenge({ challengeId: second.challengeId, code: second.code });
    expect(await identity.abortChallenge({ challengeId: second.challengeId })).toEqual({ aborted: false });
  });
});

describe('冷却与替换', () => {
  it('冷却中重发 → ChallengeCooldownError（带 retryAfterMs）', async () => {
    const { identity } = buildFixture(); // 默认 cooldown 60s
    const email = nextEmail();
    await identity.beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } });
    const error = await identity
      .beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as ChallengeCooldownError,
      );
    expect(error).toBeInstanceOf(ChallengeCooldownError);
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  it('cooldownMs=0：立即替换——旧挑战作废（旧码死、新码活），活挑战恒为一条', async () => {
    const { identity } = buildFixture({ challenge: { cooldownMs: 0 } });
    const email = nextEmail();
    const first = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: email } },
    });
    const second = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: email } },
    });
    expect(second.challengeId).not.toBe(first.challengeId);
    await expect(identity.verifyChallenge({ challengeId: first.challengeId, code: first.code })).rejects.toThrow(
      ChallengeInvalidError,
    );
    // 替换语义的活挑战唯一性：旧已作废，此刻恰一条活（second）
    const liveBefore = await db
      .select({ id: identityChallenges.id })
      .from(identityChallenges)
      .where(
        and(
          eq(identityChallenges.identifierValue, email),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
        ),
      );
    expect(liveBefore).toHaveLength(1);
    expect(liveBefore[0]!.id).toBe(second.challengeId);
    await expect(
      identity.verifyChallenge({ challengeId: second.challengeId, code: second.code }),
    ).resolves.toMatchObject({ target: { identifier: { kind: 'email', value: email }, userId: null } });
    // 消费后活挑战归零
    const liveAfter = await db
      .select({ id: identityChallenges.id })
      .from(identityChallenges)
      .where(
        and(
          eq(identityChallenges.identifierValue, email),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
        ),
      );
    expect(liveAfter).toHaveLength(0);
  });

  it('不同 kind 互不冷却/互不顶替（同邮箱注册验证与登录码并存）', async () => {
    const { identity } = buildFixture();
    const email = nextEmail();
    const a = await identity.beginChallenge({
      kind: 'email_verification',
      target: { identifier: { kind: 'email', value: email } },
    });
    const b = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: email } },
    });
    await expect(identity.verifyChallenge({ challengeId: a.challengeId, code: a.code })).resolves.toBeTruthy();
    await expect(identity.verifyChallenge({ challengeId: b.challengeId, code: b.code })).resolves.toBeTruthy();
  });
});

describe('投递', () => {
  it('deliver 抛错 → DeliveryFailedError 且挑战已作废（可立即重发）', async () => {
    let smtpDown = true;
    const { identity } = buildFixture({
      effects: {
        deliver: async () => {
          if (smtpDown) {
            smtpDown = false;
            throw new Error('smtp down');
          }
        },
      },
    });
    const email = nextEmail();
    const outcome = await identity
      .beginChallenge({ kind: 'email_code', target: { identifier: { kind: 'email', value: email } } })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as DeliveryFailedError,
      );
    expect(outcome).toBeInstanceOf(DeliveryFailedError);
    // 挑战被作废：作废后同目标立即重发不再吃冷却（活挑战已清位），且这次投递成功
    const retry = await identity.beginChallenge({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: email } },
    });
    expect(retry.code).toMatch(/^[0-9]{6}$/);
  });

  it('payload 超 4KB → InvalidInputError；非 JSON 可序列化 → InvalidInputError', async () => {
    const { identity } = buildFixture();
    await expect(
      identity.beginChallenge({
        kind: 'email_code',
        target: { identifier: { kind: 'email', value: nextEmail() } },
        payload: { blob: 'x'.repeat(5_000) },
      }),
    ).rejects.toThrow(InvalidInputError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      identity.beginChallenge({
        kind: 'email_code',
        target: { identifier: { kind: 'email', value: nextEmail() } },
        payload: circular,
      }),
    ).rejects.toThrow(InvalidInputError);
  });
});

describe('目标寻址', () => {
  it('userId 目标：email 优先于 phone（确定性选路）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'phone', value: '+8613800138000' },
    });
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: nextEmail() },
    });
    const a = await identity.beginChallenge({ kind: 'email_code', target: { userId } });
    expect(a.channel).toBe('email');
    const verified = await identity.verifyChallenge({ challengeId: a.challengeId, code: a.code });
    expect(verified.target).toEqual({ identifier: null, userId });
  });

  it('userId 只有 phone 凭据 → sms 通道', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'phone', value: '13800138001' },
    });
    const a = await identity.beginChallenge({ kind: 'sms_code', target: { userId } });
    expect(a.channel).toBe('sms');
  });

  it('userId 无任何可投递凭据 → UndeliverableChallengeError（fail-closed，不静默发）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.registerCredential({
      userId,
      identifier: { kind: 'username', value: `user_${userId}` },
    });
    await expect(identity.beginChallenge({ kind: 'email_code', target: { userId } })).rejects.toThrow(
      UndeliverableChallengeError,
    );
    await expect(identity.beginChallenge({ kind: 'email_code', target: { userId: nextUserId() } })).rejects.toThrow(
      UndeliverableChallengeError,
    );
  });

  it('username 标识目标不可投递；phone 标识目标走 sms', async () => {
    const { identity } = buildFixture();
    await expect(
      identity.beginChallenge({
        kind: 'email_code',
        target: { identifier: { kind: 'username', value: 'someone_1' } },
      }),
    ).rejects.toThrow(UndeliverableChallengeError);
    const sms = await identity.beginChallenge({
      kind: 'sms_code',
      target: { identifier: { kind: 'phone', value: '+86 139-0013-9000' } },
    });
    expect(sms.channel).toBe('sms');
    expect(sms.to).toBe('+8613900139000');
  });

  it('白名单外挑战类型 → UnknownChallengeKindError；challengeId 非法 → ChallengeInvalidError', async () => {
    const { identity } = buildFixture();
    await expect(
      identity.beginChallenge({
        kind: 'telepathy_code',
        target: { identifier: { kind: 'email', value: nextEmail() } },
      }),
    ).rejects.toThrow(UnknownChallengeKindError);
    await expect(identity.verifyChallenge({ challengeId: 'not-a-uuid', code: '123456' })).rejects.toThrow(
      ChallengeInvalidError,
    );
  });
});
