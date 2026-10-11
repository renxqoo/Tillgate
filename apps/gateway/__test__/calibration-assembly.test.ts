/**
 * 校准装配面测试（docs §3.3/§4.1）：
 *   calibration reader（TTL 缓存/单飞行/值域回落/fail-loud）；
 *   channelExposureAmounts 双金额（分段闭式/渠道不匹配回落/conservative 恒保守）。
 */
import { describe, expect, it } from 'vitest';
import { createBillingCalibrationReader } from '../src/adapters/calibration-policy.js';
import { DEFAULT_CALIBRATION_CONFIG, parseCalibrationSetting } from '@tillgate/billing';
import type { BillingPort, QuoteCandidate } from '@tillgate/inference';
import type { GatewayBillingApi } from '../src/adapters/billing-port.js';
import type { QuoteCalibrationSnapshot } from '@tillgate/inference';

type GatewayReserveInput = Parameters<BillingPort['reserveChannel']>[0];

function fakeDb(results: Array<Record<string, unknown> | null>) {
  let reads = 0;
  return {
    reads: () => reads,
    query: {
      systemConfigs: {
        findFirst: async () => {
          reads += 1;
          return results.length > 1 ? results.shift() : results[0];
        },
      },
    },
  };
}

describe('parseCalibrationSetting（值域——billing 单一真相）', () => {
  it('合法形状全参数通过', () => {
    expect(
      parseCalibrationSetting({ enabled: true, window_ms: 300_000, cache_ratio: 0.9, user_side: false }),
    ).toEqual({ enabled: true, windowMs: 300_000, cacheRatio: 0.9, userSide: false });
  });

  it.each([
    ['null', null],
    ['非对象', 'x'],
    ['enabled 缺失', { window_ms: 1, cache_ratio: 0.9, user_side: false }],
    ['cache_ratio 0', { enabled: true, window_ms: 1, cache_ratio: 0, user_side: false }],
    ['cache_ratio > 1', { enabled: true, window_ms: 1, cache_ratio: 1.5, user_side: false }],
    ['window_ms 0', { enabled: true, window_ms: 0, cache_ratio: 0.9, user_side: false }],
    ['window_ms 超 1h', { enabled: true, window_ms: 3_600_001, cache_ratio: 0.9, user_side: false }],
    ['window_ms 非整数', { enabled: true, window_ms: 1.5, cache_ratio: 0.9, user_side: false }],
    ['矛盾：关用户侧开', { enabled: false, window_ms: 1, cache_ratio: 0.9, user_side: true }],
  ])('拒绝 %s', (_name, raw) => {
    expect(parseCalibrationSetting(raw)).toBeNull();
  });

  it('边界：ratio=1 / window=1h / 关且用户侧关 → 合法', () => {
    expect(parseCalibrationSetting({ enabled: true, window_ms: 3_600_000, cache_ratio: 1, user_side: true })).toEqual({
      enabled: true,
      windowMs: 3_600_000,
      cacheRatio: 1,
      userSide: true,
    });
    expect(parseCalibrationSetting({ enabled: false, window_ms: 1_000, cache_ratio: 0.5, user_side: false })).toEqual({
      enabled: false,
      windowMs: 1_000,
      cacheRatio: 0.5,
      userSide: false,
    });
  });
});

describe('calibration reader（TTL 缓存 + 值域回落 + fail-loud）', () => {
  it('KV 命中取值；TTL 内不重复查；缺失/垃圾回落保守缺省', async () => {
    const db = fakeDb([{ value: { enabled: true, window_ms: 300_000, cache_ratio: 0.9, user_side: false } }]);
    const read = createBillingCalibrationReader({ db: db as never, ttlMs: 60_000 });
    expect(await read()).toEqual({ enabled: true, windowMs: 300_000, cacheRatio: 0.9, userSide: false });
    expect(await read()).toEqual((await read()));
    expect(db.reads()).toBe(1); // TTL 内缓存

    for (const raw of [null, { value: { enabled: 'yes' } }, { value: { enabled: true, cache_ratio: 2 } }]) {
      const fallback = createBillingCalibrationReader({ db: fakeDb([raw]) as never, ttlMs: 60_000 });
      expect(await fallback()).toEqual(DEFAULT_CALIBRATION_CONFIG); // 保守缺省
    }
  });

  it('KV 读失败抛错（fail-loud——校准事故不静默错档）', async () => {
    const db = {
      query: { systemConfigs: { findFirst: async () => { throw new Error('db down'); } } },
    };
    const read = createBillingCalibrationReader({ db: db as never, ttlMs: 60_000 });
    await expect(read()).rejects.toThrow('db down');
  });

  it('TTL 过期后刷新（admin 改动拾取延迟上界）', async () => {
    const db = fakeDb([
      { value: { enabled: false, window_ms: 300_000, cache_ratio: 0.9, user_side: false } },
      { value: { enabled: true, window_ms: 600_000, cache_ratio: 0.8, user_side: false } },
    ]);
    const read = createBillingCalibrationReader({ db: db as never, ttlMs: 1 });
    expect((await read())!.enabled).toBe(false);
    await new Promise((r) => { setTimeout(r, 3); });
    expect((await read())!.enabled).toBe(true);
    expect(db.reads()).toBe(2);
  });
});

// ---- channelExposureAmounts 双金额（经 createGatewayBilling.reserveChannel 消费面） ----

function costPrices() {
  return {
    inputPrice: '2.1',
    cacheInputPrice: '0.42',
    cacheWritePrice: '0',
    outputPrice: '8.4',
    unitPrice: '0',
  };
}

const CANDIDATE: QuoteCandidate = {
  mappingId: 13,
  externalModel: 'm',
  realModel: 'm',
  inputPrice: '2.1',
  cacheInputPrice: '0.42',
  cacheWritePrice: null,
  outputPrice: '8.4',
  unitPrice: null,
  pricingUnit: 'token',
  unitUpperBound: 0,
  coefficient: '1',
  billingPolicyFingerprint: null,
  calibratedInputTokenUpperBound: 50_600, // seen 50000 + tail 600
};

const SNAPSHOT: QuoteCalibrationSnapshot = {
  mappingId: 13,
  prefixHash: 'a'.repeat(64),
  channelId: 8,
  inputTokens: 50_000,
  messagesLen: 2,
  prefixBytes: 190_000,
  cacheRatio: 0.9,
};

function reserveInput(over: Partial<GatewayReserveInput> = {}) {
  return {
    requestId: 'r',
    channelId: 8,
    candidate: CANDIDATE,
    costPrices: costPrices(),
    estimatedInputTokens: 1_000_000, // 字节界（保守口径用）
    maxOutputTokens: 4_096,
    calibration: SNAPSHOT,
    ...over,
  };
}

/** 直接驱动 gateway reserveChannel 的 api 捕获器（双金额断言不经私有函数） */
async function captureReserveAmounts(input: ReturnType<typeof reserveInput>) {
  const { createGatewayBilling } = await import('../src/adapters/billing-port.js');
  let captured: { amount: string; conservativeChannelAmount?: string | null } | null = null;
  const api = {
    authorize: async () => {},
    signal: async () => {},
    reserveChannel: async (req: { amount: string; conservativeChannelAmount?: string | null }) => {
      captured = { amount: req.amount, conservativeChannelAmount: req.conservativeChannelAmount };
      return { allowed: true, remaining: '1', switched: false };
    },
  };
  const port = createGatewayBilling(api as never, {} as never);
  await port.reserveChannel(input);
  return captured!;
}

describe('channelExposureAmounts 双金额（docs §4.1）', () => {
  it('渠道匹配 + 候选盖章 → amount = 分段闭式；conservative = 字节界保守闭式', async () => {
    const captured = await captureReserveAmounts(reserveInput());
    // 分段：cacheSeg = 45000×0.42/1M = 0.0189；rest = 5600×2.1/1M = 0.01176；out = 4096×8.4/1M = 0.0344064
    expect(captured.amount).toBe('0.0650664');
    // conservative：全量 1M×2.1/1M + 4096×8.4/1M = 2.1 + 0.0344064
    expect(captured.conservativeChannelAmount).toBe('2.1344064');
  });

  it('渠道不匹配（failover 冷渠道）→ 双双保守：amount=conservative 且 conservative 列不落', async () => {
    const captured = await captureReserveAmounts(reserveInput({ channelId: 9 }));
    expect(captured.amount).toBe('2.1344064'); // 保守（含输出段）
    expect(captured.conservativeChannelAmount).toBeUndefined(); // 非校准预留（B4 走原路径）
  });

  it('无校准快照（未命中）→ 现状行为：amount=保守，无 conservative', async () => {
    const captured = await captureReserveAmounts(reserveInput({ calibration: undefined }));
    expect(captured.amount).toBe('2.1344064');
    expect(captured.conservativeChannelAmount).toBeUndefined();
  });

  it('候选未盖章（calibratedBound 缺失）→ 保守', async () => {
    const candidate: QuoteCandidate = { ...CANDIDATE };
    delete (candidate as { calibratedInputTokenUpperBound?: number }).calibratedInputTokenUpperBound;
    const captured = await captureReserveAmounts(reserveInput({ candidate }));
    expect(captured.amount).toBe('2.1344064');
    expect(captured.conservativeChannelAmount).toBeUndefined();
  });

  it('costPrices 缺失 → 金额 0 口径（现行免费/未配置语义不变）', async () => {
    const captured = await captureReserveAmounts(reserveInput({ costPrices: undefined }));
    expect(captured.amount).toBe('0');
    expect(captured.conservativeChannelAmount).toBeUndefined();
  });
});
