/**
 * 并发语义测试(内存复演;真实 PG 门禁在
 * postgres.real.test.ts 复验):单赢家 CAS、attempts 不越界、cooldown=0 并发替换、
 * 冷却期并发单赢家、异目标互不干扰。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';
import { defined } from './defined.js';

const harness = () => createTestHarness();
const email = (n: number) => `cc${n}@example.com`;
const TARGET = (n: number) => ({ identifier: { kind: 'email', value: email(n) } });
const KIND = 'user_login_code';

describe('挑战并发语义(内存复演)', () => {
  it('同码并发验 6 次恰 1 成功,其余 code_invalid/challenge_invalid', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(1),
      overrides: { maxAttempts: 5 },
      delivery: { ip: 'ip' },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    // 内存单线程下 6 发顺序穿 CAS:恰 1 消费,其余全部被拒(与 real 门禁同口径)
    expect(ok).toHaveLength(1);
    for (const failed of results.filter((r) => r.status === 'rejected')) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({
        code: expect.stringMatching(/^identity\.(code_invalid|challenge_invalid)$/),
      });
    }
  });

  it('并发一错一对:attempts 恰好推进,不越界', async () => {
    const h = harness();
    const begun = await h.api.challenges.begin({
      kind: KIND,
      target: TARGET(2),
      delivery: { ip: 'ip' },
    });
    const [wrong, right] = await Promise.allSettled([
      h.api.challenges.verify({ challengeId: begun.challengeId, code: '000001' }),
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ]);
    expect(wrong.status).toBe('rejected');
    expect(right.status).toBe('fulfilled');
    // 再验任何码 → 已消费
    await expect(
      h.api.challenges.verify({ challengeId: begun.challengeId, code: begun.code }),
    ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
  });

  it('cooldown=0 并行发 4 次:全成功,旧挑战被替换,活挑战恒一条且活者可验', async () => {
    const h = harness();
    const codes = await Promise.all(
      Array.from({ length: 4 }, () =>
        h.api.challenges.begin({
          kind: KIND,
          target: TARGET(3),
          overrides: { cooldownMs: 0 },
          delivery: { ip: 'ip' },
        }),
      ),
    );
    expect(new Set(codes.map((c) => c.challengeId)).size).toBe(4);
    // 最后一次创建的挑战可验,先前的全部终态
    const last = defined(codes.at(-1), 'codes.at(-1)');
    await expect(
      h.api.challenges.verify({ challengeId: last.challengeId, code: last.code }),
    ).resolves.toBeTruthy();
    for (const c of codes.slice(0, -1)) {
      await expect(
        h.api.challenges.verify({ challengeId: c.challengeId, code: c.code }),
      ).rejects.toMatchObject({ code: 'identity.challenge_invalid' });
    }
  });

  it('冷却期并行发码:至多 1 成功,其余 cooldown(内存顺序化下=首个成功)', async () => {
    const h = harness();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        h.api.challenges.begin({
          kind: KIND,
          target: TARGET(4 + (i % 1)),
          ...(i === 0 ? { delivery: { ip: 'ip' } } : {}),
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const cooldown = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r as PromiseRejectedResult).reason.code === 'identity.challenge_cooldown',
    );
    expect(ok.length).toBe(1);
    expect(cooldown.length).toBe(3);
  });

  it('5 个异目标并行互不干扰', async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.api.challenges.begin({
          kind: KIND,
          target: TARGET(10 + i),
          overrides: { cooldownMs: 0 },
          delivery: { ip: 'ip' },
        }),
      ),
    );
    expect(results.every((r) => r.code.match(/^[0-9]{6}$/))).toBe(true);
    const first = defined(results[0], 'results[0]');
    await expect(
      h.api.challenges.verify({ challengeId: first.challengeId, code: first.code }),
    ).resolves.toBeTruthy();
  });
});
