/**
 * quote 校准集成测试（docs/calibrated-exposure-estimate.md §2/§3.2a）：
 * 守卫 → 哈希链 → top-N → 命中盖章/回落；回归锚（未装配 = 逐字段现状）。
 * 纯内存 lookup（port 契约），catalog 夹具最小化。
 */
import { describe, expect, it } from 'vitest';
import { prepareChatRequest } from '../src/application/quote.js';
import type { CatalogPort, CatalogPricingContext } from '../src/ports/catalog';
import type { RequestAuth } from '../src/domain/model/types';
import type { CalibrationLookup, CalibrationLookupConfig } from '../src/ports/calibration';
import { buildMessageHashChain } from '../src/application/calibration.js';
import { defaultInferenceDefaults } from '../src/config.js';

/** 单映射单候选目录（价格与生产 MiniMax 形态同数量级） */
function catalogFixture() {
  const port: CatalogPort = {
    async findMapping(name: string, _pricing: CatalogPricingContext) {
      if (name !== 'm') return null;
      return {
        mappingId: 13,
        externalName: 'm',
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
        contextLength: null,
        fallbackModels: [],
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试夹具按需补全
  } as any;
  return port;
}

const DEFAULTS = defaultInferenceDefaults();

const AUTH: RequestAuth = {
  userId: 2,
  apiKeyId: null,
  appId: null,
  allowedModels: null,
};

const TURN1 = {
  model: 'm',
  system: 's',
  messages: [
    { role: 'user', content: 'a'.repeat(100_000) },
    { role: 'user', content: 'b'.repeat(50_000) },
  ],
};
const TURN2 = {
  ...TURN1,
  messages: [...TURN1.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }],
};

function lookupWith(records: Array<{ prefixHash: string; channelId: number; inputTokens: number; messagesLen: number; settledAt: Date }>): CalibrationLookup {
  return { async findRecent() { return records; } };
}

const CONFIG: CalibrationLookupConfig = {
  enabled: true,
  windowMs: 300_000,
  cacheRatio: 0.9,
  recentLimit: 8,
};

const NOW = new Date('2026-10-12T00:00:00Z');

function recordForTurn1(over: Partial<{ channelId: number; inputTokens: number; settledAt: Date }> = {}) {
  const chain = buildMessageHashChain({ body: TURN1 as unknown as Record<string, unknown> })!;
  return {
    prefixHash: chain.chainAt(2),
    channelId: 8,
    inputTokens: 40_000,
    messagesLen: 2,
    settledAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
}

describe('quote 校准集成（读侧）', () => {
  it('命中：主候选盖 calibratedInputTokenUpperBound = seen + 尾部字节界；快照七字段', async () => {
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r1',
      auth: AUTH,
      body: TURN2 as unknown as Record<string, unknown>,
      now: NOW,
      calibration: { lookup: lookupWith([recordForTurn1()]), config: CONFIG },
    });
    const primary = p.candidates[0]!;
    expect(primary.calibratedInputTokenUpperBound).toBeDefined();
    const tailBytes = Buffer.byteLength(
      JSON.stringify((TURN2.messages as unknown[]).slice(2)),
      'utf8',
    );
    // 校准界 = seen(40000) + 尾部字节界（尾部字节 > 字节数的 1/4 → 界 > 40000）
    expect(primary.calibratedInputTokenUpperBound!).toBe(40_000 + tailBytes);
    // 字节界不动（保守底，B2 唯一口径）
    expect(p.inputUpperBound).toBe(
      Buffer.byteLength(JSON.stringify(TURN2), 'utf8'),
    );
    expect(p.calibration).toMatchObject({ hit: true, seen: 40_000, channelId: 8 });
    expect(p.calibrationSnapshot).toMatchObject({
      mappingId: 13,
      channelId: 8,
      inputTokens: 40_000,
      messagesLen: 2,
      cacheRatio: 0.9,
    });
    expect(typeof p.calibrationSnapshot!.prefixHash).toBe('string');
    expect(p.calibrationSnapshot!.prefixHash.length).toBe(64);
  });

  it('未装配 lookup：逐字段等于现状（回归锚——calibration/snapshot 均为 null）', async () => {
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r2',
      auth: AUTH,
      body: TURN1 as unknown as Record<string, unknown>,
      now: NOW,
    });
    expect(p.calibration).toBeNull();
    expect(p.calibrationSnapshot).toBeNull();
    for (const c of p.candidates) {
      expect(c.calibratedInputTokenUpperBound).toBeUndefined();
    }
    expect(p.inputUpperBound).toBe(Buffer.byteLength(JSON.stringify(TURN1), 'utf8'));
  });

  it('C6 守卫：embeddings → resolution=guard，候选不盖章', async () => {
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r3',
      auth: AUTH,
      body: { model: 'm', input: 'x' } as unknown as Record<string, unknown>,
      endpoint: 'embeddings',
      now: NOW,
      calibration: { lookup: lookupWith([recordForTurn1()]), config: CONFIG },
    });
    expect(p.calibration).toEqual({ hit: false, missReason: 'guard' });
    expect(p.calibrationSnapshot).toBeNull();
  });

  it('disabled：resolution=disabled，不查库（lookup 抛错也不影响——安全回落）', async () => {
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r4',
      auth: AUTH,
      body: TURN2 as unknown as Record<string, unknown>,
      now: NOW,
      calibration: {
        lookup: {
          async findRecent() {
            throw new Error('must not be called');
          },
        },
        config: { ...CONFIG, enabled: false },
      },
    });
    expect(p.calibration).toEqual({ hit: false, missReason: 'disabled' });
    expect(p.calibrationSnapshot).toBeNull();
  });

  it('前缀不匹配（改写早期消息）→ no_record 回落，候选不盖章', async () => {
    const edited = {
      ...TURN2,
      messages: [{ role: 'user', content: 'EDITED' }, ...TURN2.messages.slice(1)],
    };
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r5',
      auth: AUTH,
      body: edited as unknown as Record<string, unknown>,
      now: NOW,
      calibration: { lookup: lookupWith([recordForTurn1()]), config: CONFIG },
    });
    expect(p.calibration).toEqual({ hit: false, missReason: 'no_record' });
    for (const c of p.candidates) {
      expect(c.calibratedInputTokenUpperBound).toBeUndefined();
    }
  });

  it('超窗 → window miss', async () => {
    const stale = recordForTurn1({ settledAt: new Date(NOW.getTime() - 299_000) });
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r6',
      auth: AUTH,
      body: TURN2 as unknown as Record<string, unknown>,
      now: NOW,
      calibration: { lookup: lookupWith([stale]), config: CONFIG },
    });
    expect(p.calibration).toEqual({ hit: false, missReason: 'window' });
  });

  it('lookup 存储抖动 → 安全回落（no_record），不阻断', async () => {
    const p = await prepareChatRequest({
      catalog: catalogFixture(),
      defaults: DEFAULTS,
      requestId: 'r7',
      auth: AUTH,
      body: TURN2 as unknown as Record<string, unknown>,
      now: NOW,
      calibration: {
        lookup: {
          async findRecent() {
            throw new Error('db down');
          },
        },
        config: CONFIG,
      },
    });
    expect(p.calibration).toEqual({ hit: false, missReason: 'no_record' });
    expect(p.calibrationSnapshot).toBeNull();
  });

  it('fallback 候选不盖章（仅 mappingId 匹配的主候选）', async () => {
    const catalog = catalogFixture();
    // 双候选链：主映射 m + fallback 映射 m2
    const catalogWithFallback = {
      async findMapping(name: string, pricing: CatalogPricingContext) {
        const base = await catalog.findMapping(name, pricing);
        if (base != null) return { ...base, fallbackModels: ['m2'] };
        if (name === 'm2') {
          return {
            mappingId: 99,
            externalName: 'm2',
            realModel: 'm2b',
            inputPrice: '1',
            cacheInputPrice: '1',
            cacheWritePrice: null,
            outputPrice: '1',
            unitPrice: null,
            pricingUnit: 'token',
            unitUpperBound: 0,
            coefficient: '1',
            billingPolicyFingerprint: null,
            contextLength: null,
            fallbackModels: [],
          };
        }
        return null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const p = await prepareChatRequest({
      catalog: catalogWithFallback,
      defaults: DEFAULTS,
      requestId: 'r8',
      auth: AUTH,
      body: TURN2 as unknown as Record<string, unknown>,
      now: NOW,
      calibration: { lookup: lookupWith([recordForTurn1()]), config: CONFIG },
    });
    expect(p.candidates.length).toBeGreaterThanOrEqual(2);
    const primary = p.candidates[0]!;
    const fallback = p.candidates[1]!;
    expect(primary.mappingId).toBe(13);
    expect(primary.calibratedInputTokenUpperBound).toBeDefined();
    expect(fallback.mappingId).toBe(99);
    expect(fallback.calibratedInputTokenUpperBound).toBeUndefined();
  });
});
