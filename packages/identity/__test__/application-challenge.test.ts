/**
 * 挑战用例测试(v1 challenge.test + login-challenge.test 迁移):投递、一次性消费、
 * 错次递减、冷却、kind 分桶、投递失败作废、payload 域、目标寻址、fail-closed
 * (B05 ip/locale 随调用流动 / B11 abort 失败 warn / B12 无投递器拒绝)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, TEST_CONFIG } from '../src/testing/harness.js';
import { createIdentity } from '../src/identity.js';

const harness = () => createTestHarness();
const email = (n: number) => `ch${n}@example.com`;
const TARGET = (n: number) => ({ identifier: { kind: 'email', value: email(n) } });
const KIND = 'user_login_code';

describe('challenges.begin 发码与投递', () => {
  it('发码:6 位码经 mailer 出境,ip/locale 随调用流动(B05);返回 expiresAt', async () => {
    const h = harness();
    const result = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(1),
      payload: { purpose: 'login' },
      delivery: { ip: '203.0.113.9', locale: 'zh' },
    });
    expect(result.code).toMatch(/^[0-9]{6}$/);
    expect(result.channel).toBe('email');
    expect(result.to).toBe(email(1));
    expect(h.mailer.sent).toEqual([
      { to: email(1), code: result.code, ip: '203.0.113.9', locale: 'zh' },
    ]);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(h.ctx.clock.now().getTime());
  });

  it('B05 回归:同邮箱双 kind 并发发码,投递上下文互不串号', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.api.challenges.begin({
        kind: 'user_login_code',
        target: TARGET(1),
        delivery: { ip: '10.0.0.1' },
      }),
      h.api.challenges.begin({
        kind: 'user_register_code',
        target: TARGET(1),
        delivery: { ip: '10.0.0.2' },
      }),
    ]);
    const byCode = new Map(h.mailer.sent.map((m) => [m.code, m]));
    expect(byCode.get(a.code)?.ip).toBe('10.0.0.1');
    expect(byCode.get(b.code)?.ip).toBe('10.0.0.2');
  });

  it('同 kind 同目标冷却:60s 内重发拒绝并带 retryAfterMs(B14 同钟)', async () => {
    const h = harness();
    await h.api.challenges.begin({ kind: KIND, target: TARGET(2), delivery: { ip: 'ip' } });
    h.advanceClockMs(10_000);
    await expect(h.api.challenges.begin({ kind: KIND, target: TARGET(2) })).rejects.toMatchObject({
      code: 'identity.challenge_cooldown',
    });
    try {
      await h.api.challenges.begin({ kind: KIND, target: TARGET(2) });
    } catch (error) {
      expect((error as { context?: { retryAfterMs?: number } }).context?.retryAfterMs).toBe(50_000);
    }
  });

  it('冷却已过:替换语义,活挑战恒一条;cooldownMs=0 即时替换', async () => {
    const h = harness();
    const first = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(3),
      overrides: { cooldownMs: 0 },
      delivery: { ip: 'ip' },
    });
    const second = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(3),
      overrides: { cooldownMs: 0 },
      delivery: { ip: 'ip' },
    });
    expect(second.challengeId).not.toBe(first.challengeId);
    await expect(
      h.api.challenges.verify({ challengeId: first.challengeId, code: first.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
    await expect(
      h.api.challenges.verify({ challengeId: second.challengeId, code: second.code }),
    ).resolves.toMatchObject({ target: { identifier: { kind: 'email', value: email(3) } } });
  });

  it('kind 分桶:不同 kind 互不冷却、互不顶替', async () => {
    const h = harness();
    await h.api.challenges.begin({ kind: KIND, target: TARGET(4), delivery: { ip: 'ip' } });
    await expect(
      h.api.challenges.begin({
        kind: 'user_register_code',
        target: TARGET(4),
        delivery: { ip: 'ip' },
      }),
    ).resolves.toMatchObject({ channel: 'email' });
  });

  it('投递失败:挑战作废 + delivery_failed,可立即重发(冷却让位)', async () => {
    const h = harness();
    h.mailer.failNext();
    await expect(h.api.challenges.begin({ kind: KIND, target: TARGET(5) })).rejects.toMatchObject({
      code: 'identity.delivery_failed',
    });
    await expect(
      h.api.challenges.begin({ kind: KIND, target: TARGET(5), delivery: { ip: 'ip' } }),
    ).resolves.toMatchObject({ channel: 'email' });
  });

  it('B11 回归:投递失败且补救 abort 也失败 → warn 而非静默', async () => {
    const h = harness();
    const warn = vi.fn();
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn },
      config: TEST_CONFIG,
      store: {
        ...h.store,
        abortChallenge: async () => {
          throw new Error('connection reset');
        },
      },
      mailer: {
        sendLoginCode: async () => {
          throw new Error('smtp down');
        },
        sendPasswordResetLink: async () => {
          throw new Error('smtp down');
        },
      },
    });
    await expect(
      api.challenges.begin({ kind: KIND, target: TARGET(6), delivery: { ip: 'ip' } }),
    ).rejects.toMatchObject({ code: 'identity.delivery_failed' });
    expect(warn).toHaveBeenCalled();
  });
});

describe('challenges.begin 目标寻址与 fail-closed', () => {
  it('userId 目标:email 优先(email+phone 并存)', async () => {
    const h = harness();
    await h.api.credentials.register({
      userId: 1,
      identifier: { kind: 'phone', value: '+8613800138000' },
    });
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(7) } });
    const result = await h.api.challenges.begin({
      kind: KIND,
      target: { userId: 1 },
      delivery: { ip: 'ip' },
    });
    expect(result.to).toBe(email(7));
  });

  it('userId 仅 phone → undeliverable(sms 未实现 fail-closed,W6)', async () => {
    const h = harness();
    await h.api.credentials.register({
      userId: 1,
      identifier: { kind: 'phone', value: '+8613800138000' },
    });
    await expect(
      h.api.challenges.begin({ kind: KIND, target: { userId: 1 } }),
    ).rejects.toMatchObject({
      code: 'identity.undeliverable_challenge',
    });
  });

  it('username 目标无通道 → undeliverable;phone 标识目标同(SMS 未实现)', async () => {
    const h = harness();
    await expect(
      h.api.challenges.begin({
        kind: KIND,
        target: { identifier: { kind: 'username', value: 'alice_dev' } },
      }),
    ).rejects.toMatchObject({ code: 'identity.undeliverable_challenge' });
    await expect(
      h.api.challenges.begin({
        kind: KIND,
        target: { identifier: { kind: 'phone', value: '+8613800138000' } },
      }),
    ).rejects.toMatchObject({ code: 'identity.undeliverable_challenge' });
  });

  it('B12 回归:未装配 mailer 的 email 目标 = undeliverable(不建挑战,明文码不出境)', async () => {
    const h = harness();
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => undefined },
      config: TEST_CONFIG,
      store: h.store,
    });
    await expect(api.challenges.begin({ kind: KIND, target: TARGET(8) })).rejects.toMatchObject({
      code: 'identity.undeliverable_challenge',
    });
  });

  it('payload 超限/不可序列化拒绝;非法 target 形状拒绝;词表外 kind 拒绝', async () => {
    const h = harness();
    await expect(
      h.api.challenges.begin({ kind: KIND, target: TARGET(9), payload: { big: 'x'.repeat(4097) } }),
    ).rejects.toMatchObject({ code: 'identity.invalid_input' });
    await expect(h.api.challenges.begin({ kind: KIND, target: {} as never })).rejects.toMatchObject(
      { code: 'identity.invalid_input' },
    );
    await expect(
      h.api.challenges.begin({ kind: 'unknown_kind', target: TARGET(9) }),
    ).rejects.toMatchObject({ code: 'identity.unknown_challenge_kind' });
  });
});

describe('challenges.verify / abort', () => {
  it('验码还目标与载荷;一次性消费(同码二次 invalid)', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(10),
      payload: { passwordHash: 'x' },
      delivery: { ip: 'ip' },
    });
    const verified = await h.api.challenges.verify({
      challengeId: begun.challengeId,
      code: begun.code,
    });
    expect(verified.payload).toEqual({ passwordHash: 'x' });
    expect(verified.target).toEqual({
      identifier: { kind: 'email', value: email(10) },
      userId: null,
    });
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
  });

  it('错码 1-4 次 code_invalid 带 remaining 递减;第 5 次耗尽 invalid;之后正确码也 invalid', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(11),
      delivery: { ip: 'ip' },
    });
    for (let i = 1; i <= 4; i += 1) {
      await expect(
        h.api.challenges.verify({ challengeId: begun.challengeId, code: '000000' }),
      ).rejects.toMatchObject({
        code: 'identity.code_invalid',
        context: { remainingAttempts: 5 - i },
      });
    }
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: '000000' }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
  });

  it('过期即死', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(12),
      delivery: { ip: 'ip' },
    });
    h.advanceClockMs(300_001);
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
  });

  it('abort 幂等 + 终态互斥(已消费不可 abort);abort 后验码 invalid;非法 uuid 静默 false', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(13),
      delivery: { ip: 'ip' },
    });
    await expect(h.api.challenges.abort({ challengeId: begun.challengeId })).resolves.toEqual({
      aborted: true,
    });
    await expect(h.api.challenges.abort({ challengeId: begun.challengeId })).resolves.toEqual({
      aborted: false,
    });
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
    const consumed = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(14),
      delivery: { ip: 'ip' },
    });
    await h.api.challenges.verify({ challengeId: consumed.challengeId, code: consumed.code });
    await expect(h.api.challenges.abort({ challengeId: consumed.challengeId })).resolves.toEqual({
      aborted: false,
    });
    await expect(h.api.challenges.abort({ challengeId: 'not-a-uuid' })).resolves.toEqual({
      aborted: false,
    });
  });

  it('expect 归属比对:不符按挑战无效拒绝且挑战被消费(v1 expectEmail 泛化;命中样例用独立挑战)', async () => {
    const h = harness();
    const mismatch = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(15),
      delivery: { ip: 'ip' },
    });
    await expect(
      h.api.challenges.verify({
        challengeId: mismatch.challengeId,
        code: mismatch.code,
        expect: { identifier: { kind: 'email', value: email(99) } },
      }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
    // 归属不符的验码也消费挑战(CAS 先行,expect 比对在后——v1 语义)
    await expect(
      h.api.challenges.verify({ challengeId: mismatch.challengeId, code: mismatch.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });

    const match = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(16),
      delivery: { ip: 'ip' },
    });
    await expect(
      h.api.challenges.verify({
        challengeId: match.challengeId,
        code: match.code,
        expect: { identifier: { kind: 'email', value: email(16) } },
      }),
    ).resolves.toBeTruthy();
  });
});
