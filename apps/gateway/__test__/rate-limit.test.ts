/**
 * 限流闸策略契约（机制段在
 * runtime 包 rate-limiter.test）：
 * 并罚制（key+user+global RPM 原子；TPM 预占）/ 维度串不外泄 / Retry-After 上下文 /
 * 未装配放行 / TPM 失败释放 / 渠道维 RPM 尝试前判定。limiter 为可编程替身。
 */
import { describe, expect, it } from 'vitest';
import { GatewayErrors } from '../src/http/openai-error-face';
import {
  admitRequest,
  tryChannelAdmission,
  tryModelAdmission,
  type RateLimitGate,
} from '../src/http/middleware/rate-limit';
import { defined } from './defined';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import type { AuthContext } from '../src/http/middleware/api-key';

function fakeLimiter(
  over: Partial<Record<'checkAll' | 'reserveTpmAll' | 'check' | 'releaseTpm', unknown>> = {},
) {
  const calls = {
    checkAll: [] as unknown[][],
    reserveTpmAll: [] as unknown[][],
    released: [] as string[],
    channelChecks: [] as unknown[][],
  };
  const limiter = {
    checkAll: async (dims: unknown[], requestId: string) => {
      calls.checkAll.push([dims, requestId]);
      return (over.checkAll as (() => object) | undefined)?.() ?? { allowed: true };
    },
    reserveTpmAll: async (dims: unknown[], requestId: string) => {
      calls.reserveTpmAll.push([dims, requestId]);
      return (over.reserveTpmAll as (() => object) | undefined)?.() ?? { allowed: true };
    },
    check: async (dimension: string, max: number, member: string) => {
      calls.channelChecks.push([dimension, max, member]);
      return (over.check as (() => object) | undefined)?.() ?? { allowed: true };
    },
    releaseTpm: async (requestId: string) => {
      calls.released.push(requestId);
    },
  } as unknown as SlidingWindowLimiter;
  return { limiter, calls };
}

const auth = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 42,
  apiKeyId: 7,
  appId: null,
  allowedModels: null,
  rpmLimit: 60,
  tpmLimit: 100_000,
  userRpmLimit: 30,
  userTpmLimit: 50_000,
  ...over,
});

const gate = (
  limiter: SlidingWindowLimiter,
  globalRpm: number | null = 2_000,
  preauthIpRpm: number | null = null,
): RateLimitGate => ({
  limiter,
  globalRpm,
  preauthIpRpm,
});

describe('admitRequest 并罚制', () => {
  it('RPM 维 = key + user + global 三维原子检查；TPM 维 = key + user 预占', async () => {
    const { limiter, calls } = fakeLimiter();
    const handle = await admitRequest(gate(limiter), {
      requestId: 'r-1',
      auth: auth(),
      estimatedTokens: 1_234,
    });
    expect(defined(calls.checkAll[0], 'checkAll[0]')[0]).toEqual([
      { dimension: 'key:7', max: 60 },
      { dimension: 'user:42', max: 30 },
      { dimension: 'global', max: 2_000 },
    ]);
    expect(defined(calls.reserveTpmAll[0], 'reserveTpmAll[0]')[0]).toEqual([
      { dimension: 'key:7', estimatedTokens: 1_234, max: 100_000 },
      { dimension: 'user:42', estimatedTokens: 1_234, max: 50_000 },
    ]);
    await handle.release();
    expect(calls.released).toEqual(['r-1']);
  });

  it('任一 RPM 维超限即拒（并罚制：不做凭证>用户择优）——key 维命中', async () => {
    const { limiter } = fakeLimiter({ checkAll: () => ({ allowed: false, retryAfterSec: 42 }) });
    await expect(
      admitRequest(gate(limiter), { requestId: 'r', auth: auth(), estimatedTokens: 1 }),
    ).rejects.toMatchObject({ code: 'gateway.rate_limit_exceeded' });
  });

  it('TPM 拒绝同样 429 且不预占（reserveTpmAll 拒绝语义由 limiter 原子保证）', async () => {
    const { limiter, calls } = fakeLimiter({
      reserveTpmAll: () => ({ allowed: false, retryAfterSec: 17 }),
    });
    await expect(
      admitRequest(gate(limiter), { requestId: 'r', auth: auth(), estimatedTokens: 1 }),
    ).rejects.toMatchObject({ code: 'gateway.rate_limit_exceeded' });
    expect(calls.released).toEqual([]); // 未预占不释放
  });

  it('无凭证维（JWT：apiKeyId=null）→ 仅 user + global 维', async () => {
    const { limiter, calls } = fakeLimiter();
    await admitRequest(gate(limiter, null), {
      requestId: 'r',
      auth: auth({ apiKeyId: null, rpmLimit: 10, tpmLimit: 10 }),
      estimatedTokens: 5,
    });
    expect(defined(calls.checkAll[0], 'checkAll[0]')[0]).toEqual([
      { dimension: 'user:42', max: 30 },
    ]);
    expect(defined(calls.reserveTpmAll[0], 'reserveTpmAll[0]')[0]).toEqual([
      { dimension: 'user:42', estimatedTokens: 5, max: 50_000 },
    ]);
  });

  it('App-JWT 凭证（apiKeyId=null, appId 在场）：维度同 user-only，span 凭证维走 app:', async () => {
    const { limiter, calls } = fakeLimiter();
    await admitRequest(gate(limiter, null), {
      requestId: 'r',
      auth: auth({ apiKeyId: null, appId: 9, rpmLimit: 10, tpmLimit: 10 }),
      estimatedTokens: 5,
    });
    expect(defined(calls.checkAll[0], 'checkAll[0]')[0]).toEqual([
      { dimension: 'user:42', max: 30 },
    ]);
  });

  it('限流维度串不外泄：错误码可编程分派，无 dimension 泄漏', async () => {
    const { limiter } = fakeLimiter({ checkAll: () => ({ allowed: false, dimension: 'key:7' }) });
    const err = await admitRequest(gate(limiter), {
      requestId: 'r',
      auth: auth(),
      estimatedTokens: 1,
    }).catch((error: Error & { context?: Record<string, unknown> }) => error);
    expect((err as { code?: string }).code).toBe(GatewayErrors.code('rate_limit_exceeded'));
    expect(JSON.stringify((err as { context?: unknown }).context ?? {})).not.toContain('key:7');
  });

  it('未装配 gate = 全放行（单副本开发形态）', async () => {
    const handle = await admitRequest(undefined, {
      requestId: 'r',
      auth: auth(),
      estimatedTokens: 1,
    });
    await handle.release(); // no-op 不抛
  });
});

describe('admitRequest TPM 豁免维（按张/按秒计费端点）', () => {
  it('exemptTpm = true：RPM 照查、TPM 不预占（模态族计价单位非 token——TPM 维无意义）', async () => {
    const { limiter, calls } = fakeLimiter();
    await admitRequest(gate(limiter), {
      requestId: 'rq-x',
      auth: auth(),
      estimatedTokens: 0,
      exemptTpm: true,
    });
    expect(calls.checkAll).toHaveLength(1);
    expect(calls.reserveTpmAll).toHaveLength(0);
  });
});

describe('tryChannelAdmission（渠道维 RPM + TPM 尝试前判定）', () => {
  it('渠道限额缺失/未装配 = 放行；RPM 有限额走 limiter.check（member 随机）', async () => {
    const { limiter, calls } = fakeLimiter();
    expect(
      await tryChannelAdmission(
        undefined,
        { channelId: 1, rpmLimit: 10 },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(true);
    expect(
      await tryChannelAdmission(
        gate(limiter),
        { channelId: 1, rpmLimit: null },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(true);
    expect(
      await tryChannelAdmission(
        gate(limiter),
        { channelId: 3, rpmLimit: 99 },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(true);
    expect(calls.channelChecks[0]).toEqual(['channel:3', 99, expect.any(String)]);
  });

  it('渠道维 RPM 超限 → false（换渠语义，不触 TPM 预占）', async () => {
    const { limiter, calls } = fakeLimiter({ check: () => ({ allowed: false }) });
    expect(
      await tryChannelAdmission(
        gate(limiter),
        { channelId: 3, rpmLimit: 99, tpmLimit: 1_000 },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(false);
    expect(calls.reserveTpmAll).toHaveLength(0);
  });

  it('渠道维 TPM 预占（与 key/user 同 requestId 预占哈希——release/backfill 统一收口）', async () => {
    const { limiter, calls } = fakeLimiter();
    expect(
      await tryChannelAdmission(
        gate(limiter),
        { channelId: 3, rpmLimit: null, tpmLimit: 50_000 },
        { estimatedTokens: 42, requestId: 'rq-3' },
      ),
    ).toBe(true);
    expect(calls.reserveTpmAll[0]).toEqual([
      [{ dimension: 'channel:3', estimatedTokens: 42, max: 50_000 }],
      'rq-3',
    ]);
  });

  it('渠道维 TPM 超限 → false', async () => {
    const { limiter } = fakeLimiter({ reserveTpmAll: () => ({ allowed: false }) });
    expect(
      await tryChannelAdmission(
        gate(limiter),
        { channelId: 3, rpmLimit: null, tpmLimit: 5 },
        { estimatedTokens: 1, requestId: 'rq' },
      ),
    ).toBe(false);
  });
});

describe('tryModelAdmission（模型维 RPM + TPM——管理台可配限流生效）', () => {
  it('未装配/无限额 = 放行且零 limiter 调用', async () => {
    const { limiter, calls } = fakeLimiter();
    expect(
      await tryModelAdmission(
        undefined,
        { realModel: 'r', rpmLimit: 10, tpmLimit: 10 },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(true);
    expect(
      await tryModelAdmission(
        gate(limiter),
        { realModel: 'r', rpmLimit: null, tpmLimit: null },
        { estimatedTokens: 5, requestId: 'rq' },
      ),
    ).toBe(true);
    expect(calls.channelChecks).toHaveLength(0);
    expect(calls.reserveTpmAll).toHaveLength(0);
  });

  it('RPM 有限额走 check（member=requestId）；拒绝 → false（不触 TPM）', async () => {
    const { limiter, calls } = fakeLimiter({ check: () => ({ allowed: false }) });
    expect(
      await tryModelAdmission(
        gate(limiter),
        { realModel: 'gpt-x-real', rpmLimit: 10, tpmLimit: 1_000 },
        { estimatedTokens: 5, requestId: 'rq-1' },
      ),
    ).toBe(false);
    expect(calls.channelChecks[0]).toEqual(['model:gpt-x-real', 10, 'rq-1']);
    expect(calls.reserveTpmAll).toHaveLength(0);
  });

  it('RPM 通过后 TPM 预占 model 维（realModel 维度串）', async () => {
    const { limiter, calls } = fakeLimiter();
    expect(
      await tryModelAdmission(
        gate(limiter),
        { realModel: 'gpt-x-real', rpmLimit: 10, tpmLimit: 1_000 },
        { estimatedTokens: 42, requestId: 'rq-2' },
      ),
    ).toBe(true);
    expect(calls.reserveTpmAll[0]).toEqual([
      [{ dimension: 'model:gpt-x-real', estimatedTokens: 42, max: 1_000 }],
      'rq-2',
    ]);
  });

  it('模型维 TPM 超限 → false（换候选——fallback 模型接手）', async () => {
    const { limiter } = fakeLimiter({ reserveTpmAll: () => ({ allowed: false }) });
    expect(
      await tryModelAdmission(
        gate(limiter),
        { realModel: 'r', rpmLimit: null, tpmLimit: 5 },
        { estimatedTokens: 1, requestId: 'rq' },
      ),
    ).toBe(false);
  });
});
