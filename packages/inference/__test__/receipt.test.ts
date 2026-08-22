import { describe, expect, it } from 'vitest';
import { buildReceipt } from '../src/domain/usage/receipt';
import { usageForNonStream, usageForStream } from '../src/domain/usage/receipt-usage';
import { baseAuth, usage } from './harness';
import type { QuoteCandidate } from '../src/domain/model/types';

const candidate: QuoteCandidate = {
  mappingId: 11,
  externalModel: 'gpt-x',
  realModel: 'gpt-x-real',
  inputPrice: '2',
  cacheInputPrice: '1',
  cacheWritePrice: '3',
  outputPrice: '8',
  unitPrice: '1.5',
  pricingUnit: 'token',
  unitUpperBound: 0,
  coefficient: '1.2',
  billingPolicyFingerprint: 'fp-1',
};

function receiptOf(overrides: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  return buildReceipt({
    requestId: 'req-1',
    auth: baseAuth,
    candidate,
    externalModel: 'gpt-x',
    channelId: 7,
    channelKey: 'ch-7',
    durationMs: 120,
    body: { model: 'gpt-x' },
    usage: {
      estimated: false,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 50,
      cacheWriteTokens: 10,
    },
    ...overrides,
  });
}

describe('domain/usage/receipt：收据装配（价格快照 + 可信/估算 usage + units）', () => {
  it('可信 usage：三价快照 + cacheWrite 透传 + credentialType（appId 派生 jwt）', () => {
    const receipt = receiptOf({
      auth: { ...baseAuth, appId: 33 },
    });
    expect(receipt).toMatchObject({
      credentialType: 'jwt',
      realModel: 'gpt-x-real',
      inputPrice: '2',
      outputPrice: '8',
      cacheInputPrice: '1',
      cacheWritePrice: '3',
      unitPrice: '1.5',
      coefficient: '1.2',
      mappingId: 11,
      billingPolicyFingerprint: 'fp-1',
      stream: false,
      streamAborted: false,
    });
    expect(receipt.usage).toEqual({
      estimated: false,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 50,
      cacheWriteTokens: 10,
    });
    expect(receipt.estimatedFor).toBeUndefined();
  });

  it('估算 usage：cachedInputTokens 恒 0 + estimatedFor=usage_missing_nonstream + bytesRelayed=0', () => {
    const receipt = receiptOf({
      usage: { estimated: true, inputTokens: 88, outputTokens: 9 },
    });
    expect(receipt.usage).toEqual({
      estimated: true,
      inputTokens: 88,
      outputTokens: 9,
      cachedInputTokens: 0,
    });
    expect(receipt.estimatedFor).toBe('usage_missing_nonstream');
    expect(receipt.bytesRelayed).toBe(0);
  });

  it('单位计量：image 响应张数入 usage.units（不装配即漏收）', () => {
    const receipt = receiptOf({
      candidate: { ...candidate, pricingUnit: 'image' },
      responseBody: { data: [{}, {}] },
    });
    expect(receipt.usage.units).toBe(2);
  });

  it('units=0 时省略字段；cacheWrite=0 时省略（快照最小化）', () => {
    const receipt = receiptOf({
      usage: { estimated: false, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    });
    expect('units' in receipt.usage).toBe(false);
    expect('cacheWriteTokens' in receipt.usage).toBe(false);
  });

  it('cacheWritePrice/unitPrice 缺目录值兜底为 0 字符串（结算公式不收 null）', () => {
    const receipt = receiptOf({
      candidate: { ...candidate, cacheWritePrice: null, unitPrice: null },
    });
    expect(receipt.cacheWritePrice).toBe('0');
    expect(receipt.unitPrice).toBe('0');
  });
});

const weights = {
  cjkTokensPerChar: 0.7,
  tokensPerWord: 1.1,
  tokensPerNumber: 1.0,
  tokensPerSymbol: 1.0,
};

describe('domain/usage/receipt-usage：usage 信任政策', () => {
  it('非流式：可信 usage 直通（cacheWrite>0 透传）', () => {
    expect(usageForNonStream(usage({ cacheWriteTokens: 7 }), {}, 0, weights)).toEqual({
      estimated: false,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      cacheWriteTokens: 7,
    });
  });

  it('非流式：ai 估算 usage 采纳其数值（模型感知优先）；完全缺失回落本包口径', () => {
    expect(
      usageForNonStream(
        usage({ estimated: true, inputTokens: 70, outputTokens: 30 }),
        {},
        0,
        weights,
      ),
    ).toEqual({ estimated: true, inputTokens: 70, outputTokens: 30 });
    const fallback = usageForNonStream(undefined, { content: '你好' }, 42, weights);
    expect(fallback.estimated).toBe(true);
    expect(fallback.inputTokens).toBe(42);
    expect(fallback.outputTokens).toBeGreaterThan(0);
    // 序列化失败也不崩
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(usageForNonStream(undefined, cyclic, 5, weights).outputTokens).toBe(0);
  });

  it('流式：可信累计 usage → 正常结算（不标中断——v1 政策）', () => {
    const verdict = usageForStream(
      { usage: usage({ inputTokens: 9 }), terminated: 'client_disconnect' },
      42,
      weights,
    );
    expect(verdict.usage).toEqual({
      estimated: false,
      inputTokens: 9,
      cachedInputTokens: 0,
      outputTokens: 50,
    });
    expect(verdict.streamAborted).toBe(false);
    expect(verdict.estimatedFor).toBeUndefined();
  });

  it('流式：缺 usage → input 取最佳可得估算、output 按 outputFeatures、归属细分', () => {
    const verdict = usageForStream(
      {
        terminated: 'upstream_truncated',
        bytesRelayed: 1024,
        outputFeatures: { cjkChars: 10, wordSegments: 0, numberSegments: 0, symbolCount: 0 },
      },
      42,
      weights,
    );
    expect(verdict.usage).toEqual({ estimated: true, inputTokens: 42, outputTokens: 7 });
    expect(verdict.estimatedFor).toBe('upstream_error_partial');
    expect(verdict.bytesRelayed).toBe(1024);
    expect(verdict.streamAborted).toBe(true);
  });

  it('流式：ai 估算 usage 的 input 优先于兜底；无 features 输出 0（零交付不虚估）', () => {
    const verdict = usageForStream(
      { usage: usage({ estimated: true, inputTokens: 77 }), terminated: 'inactivity' },
      42,
      weights,
    );
    expect(verdict.usage.inputTokens).toBe(77);
    expect(verdict.usage.outputTokens).toBe(0);
    expect(verdict.estimatedFor).toBe('inactivity_timeout');
  });
});
