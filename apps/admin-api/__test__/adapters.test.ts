import { describe, expect, it, vi } from 'vitest';
import type { Ai, UpstreamError } from '@tokenlens/ai';
import { createUpstreamProbe } from '../src/adapters/upstream-probe';
import { createAdminSessionRevocation } from '../src/adapters/redis-session-revocation';
import { createAdminFundingResolver } from '../src/adapters/funding-resolver';
import {
  createAuditSinkBridge,
  createSessionInvalidationBridge,
  createWalletCreditBridge,
} from '../src/adapters/accounts-bridges';

/**
 * 装配面桥接件单测(DESIGN §5 D9/D10/G1 裁决的行为锁)。
 */
const fakeUpstreamError = (vendorCode?: string) =>
  ({
    kind: 'http_error',
    message: 'upstream said no',
    ...(vendorCode !== undefined ? { vendorCode } : {}),
  }) as unknown as UpstreamError;

function fakeAi(overrides: { probe?: Ai['probe']; chat?: Ai['chat'] }): Ai {
  return {
    probe: overrides.probe ?? (async () => ({ ok: true, durationMs: 3 })),
    chat: overrides.chat ?? (async () => ({ ok: true, durationMs: 4 })),
  } as unknown as Ai;
}

describe('accounts 三桥', () => {
  it('walletCredit:credit 透传 + replayed 回传;memo 可选', async () => {
    const credit = vi.fn(async () => ({
      transactionId: 1,
      amount: '5',
      balanceAfter: '10',
      replayed: true,
    }));
    const bridge = createWalletCreditBridge({ credit });
    await expect(
      bridge.credit({} as never, { refType: 'gift', refId: 'g1', userId: 1, amount: '5' }),
    ).resolves.toEqual({ replayed: true });
    expect(credit).toHaveBeenCalledWith({ userId: 1, amount: '5', refType: 'gift', refId: 'g1' });
    await bridge.credit({} as never, {
      refType: 'referral',
      refId: 'r1',
      userId: 2,
      amount: '1',
      memo: 'm',
    });
    expect(credit).toHaveBeenLastCalledWith(expect.objectContaining({ memo: 'm' }));
  });

  it('sessionInvalidation:advance 透传;失败上抛(不静默吞——D10)', async () => {
    const advance = vi.fn(async () => '2026-01-01');
    const bridge = createSessionInvalidationBridge({ advance });
    await bridge.invalidateUserSessions({} as never, { realm: 'user', userId: 3 });
    expect(advance).toHaveBeenCalledWith({ realm: 'user', userId: 3 });
    const failing = createSessionInvalidationBridge({
      advance: async () => {
        throw new Error('anchor store down');
      },
    });
    await expect(
      failing.invalidateUserSessions({} as never, { realm: 'user', userId: 3 }),
    ).rejects.toThrow('anchor store down');
  });

  it('auditSink:字段齐全/缺省两形态(G1 同事务透传)', async () => {
    const audit = vi.fn(async () => undefined);
    const bridge = createAuditSinkBridge(audit);
    await bridge.record({} as never, {
      actor: 'admin',
      adminId: 7,
      action: 'user.update',
      targetType: 'user',
      targetId: '42',
      detail: { a: 1 },
    });
    expect(audit).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ targetId: '42', detail: { a: 1 }, actor: 'admin' }),
    );
    await bridge.record({} as never, {
      actor: 'system',
      adminId: null,
      action: 'x',
      targetType: 'y',
    });
    expect(audit).toHaveBeenLastCalledWith(
      {},
      expect.not.objectContaining({ targetId: expect.anything(), detail: expect.anything() }),
    );
  });
});

describe('上游探针桥接件', () => {
  it('probeChannel:成功直通;上游失败 = 探针结果(含 vendorCode 映射)', async () => {
    const probe = createUpstreamProbe(() => fakeAi({}));
    await expect(
      probe.probeChannel({ baseUrl: 'https://u', apiKey: 'k', protocol: 'openai-compatible' }),
    ).resolves.toEqual({ ok: true, durationMs: 3 });
    const failing = createUpstreamProbe(() =>
      fakeAi({
        probe: async () => ({ ok: false, durationMs: 9, error: fakeUpstreamError('rate_limited') }),
      }),
    );
    await expect(
      failing.probeChannel({ baseUrl: 'https://u', apiKey: 'k', protocol: 'p' }),
    ).resolves.toEqual({
      ok: false,
      durationMs: 9,
      error: { code: 'rate_limited', message: 'upstream said no' },
    });
  });

  it('probeModel:"1"+max_tokens=1 零重试;usage 汇总 tokens;无 usage 缺省', async () => {
    const chat = vi.fn(async () => ({
      ok: true as const,
      durationMs: 12,
      usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, estimated: false, raw: null },
    }));
    const probe = createUpstreamProbe(() => fakeAi({ chat }));
    const outcome = await probe.probeModel(
      { baseUrl: 'https://u', apiKey: 'k', protocol: 'p' },
      'm',
      { requestId: 'r' },
    );
    expect(outcome).toEqual({ ok: true, durationMs: 12, tokens: 5 });
    expect(chat).toHaveBeenCalledWith(
      { baseUrl: 'https://u', apiKey: 'k', protocol: 'p' },
      { model: 'm', messages: [{ role: 'user', content: '1' }], max_tokens: 1 },
      { requestId: 'r', maxRetries: 0 },
    );
    const noUsage = createUpstreamProbe(() =>
      fakeAi({ chat: async () => ({ ok: true as const, durationMs: 1 }) }),
    );
    await expect(
      noUsage.probeModel({ baseUrl: 'https://u', apiKey: 'k', protocol: 'p' }, 'm', {
        requestId: 'r',
      }),
    ).resolves.toEqual({ ok: true, durationMs: 1 });
  });

  it('probeModel:上游失败走 error 面(kind 兜底码)', async () => {
    const probe = createUpstreamProbe(() =>
      fakeAi({ chat: async () => ({ ok: false, durationMs: 7, error: fakeUpstreamError() }) }),
    );
    await expect(
      probe.probeModel({ baseUrl: 'https://u', apiKey: 'k', protocol: 'p' }, 'm', {
        requestId: 'r',
      }),
    ).resolves.toEqual({
      ok: false,
      durationMs: 7,
      error: { code: 'http_error', message: 'upstream said no' },
    });
  });
});

describe('资金来源解析器红灯(D2)', () => {
  it('resolve 显式拒绝(admin 面无推理授权链)', () => {
    const resolver = createAdminFundingResolver();
    expect(() =>
      resolver.resolve({} as never, { userId: 1, apiKeyId: null, appId: null }),
    ).toThrowError(/no inference authorize path/);
  });
});

describe('会话 jti 吊销表（Redis 适配器）', () => {
  it('revoke 写 EX 键（TTL 下限 1s）;isRevoked 按 exists 判定', async () => {
    const store = new Map<string, unknown[]>();
    const redis = {
      set: vi.fn(async (key: string, _v: string, ...rest: unknown[]) => {
        store.set(key, rest);
        return 'OK';
      }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    };
    const revocation = createAdminSessionRevocation(redis as never);
    expect(await revocation.isRevoked('jti-1')).toBe(false);
    await revocation.revoke('jti-1', 0); // 剩余 0s → 下限 1s
    expect(redis.set).toHaveBeenCalledWith('admin:session:jti:jti-1', '1', 'EX', 1);
    expect(await revocation.isRevoked('jti-1')).toBe(true);
  });
});
