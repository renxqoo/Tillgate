/**
 * 结算用量验收门（docs/usage-acceptance/DESIGN.md 测试口径）：
 * 三界钳制矩阵 / 估算直通 / 旧数据缺界跳过 / 恰好等于界不钳 / 违规事实完整记录。
 */
import { describe, expect, it } from 'vitest';
import { acceptTrustedUsage } from '../src/domain/rating/usage-acceptance';
import type { BillingQuote, UsageReceipt } from '../src/domain/rating/types';

function receiptOf(usage: Partial<UsageReceipt['usage']>): UsageReceipt {
  return {
    requestId: 'r1',
    userId: 1,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'm',
    realModel: 'm',
    channelId: 2,
    channelKey: 'k',
    usage: {
      estimated: false,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      ...usage,
    },
    inputPrice: '1',
    outputPrice: '2',
    cacheInputPrice: '0',
    cacheWritePrice: '0',
    unitPrice: '0',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 7,
    billingPolicyFingerprint: null,
  } as UsageReceipt;
}

function quoteOf(bound: { maxOutputTokens?: number; inputUpper?: number; unitUpper?: number }): BillingQuote {
  return {
    maxOutputTokens: bound.maxOutputTokens ?? 1000,
    candidates: [
      {
        mappingId: 7,
        externalModel: 'm',
        realModel: 'm',
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0',
        coefficient: '1',
        inputTokenUpperBound: bound.inputUpper ?? 5000,
        ...(bound.unitUpper !== undefined ? { unitUpperBound: bound.unitUpper } : {}),
        billingPolicyFingerprint: null,
      },
    ],
  } as unknown as BillingQuote;
}

describe('acceptTrustedUsage', () => {
  it('界内发票原引用直通（零拷贝、零违规）', () => {
    const r = receiptOf({ inputTokens: 100, outputTokens: 50 });
    const out = acceptTrustedUsage({ receipt: r, quote: quoteOf({}) });
    expect(out.receipt).toBe(r);
    expect(out.clamps).toEqual([]);
  });

  it('估算收据不经验收门（我方口径有界性由构造保证）', () => {
    const r = receiptOf({ estimated: true, inputTokens: 99_999_999, outputTokens: 88_888_888 } as never);
    const out = acceptTrustedUsage({ receipt: r, quote: quoteOf({}) });
    expect(out.receipt).toBe(r);
    expect(out.clamps).toEqual([]);
  });

  it('B1/B2：伪造巨量发票被钳到准入界（今晨事故形状：30M token vs cap=100）', () => {
    const out = acceptTrustedUsage({
      receipt: receiptOf({ inputTokens: 20_000_000, outputTokens: 10_000_000 }),
      quote: quoteOf({ maxOutputTokens: 100, inputUpper: 30 }),
    });
    expect(out.receipt.usage.inputTokens).toBe(30);
    expect(out.receipt.usage.outputTokens).toBe(100);
    expect(out.clamps.map((c) => c.kind).toSorted()).toEqual(['input_bound', 'output_cap']);
    expect(out.clamps.find((c) => c.kind === 'input_bound')).toMatchObject({ original: 20_000_000, clamped: 30 });
  });

  it('B3：证据字节钳输出（界内虚报收敛到观测证据）', () => {
    const out = acceptTrustedUsage({
      receipt: { ...receiptOf({ outputTokens: 5000 }), outputEvidenceBytes: 400 },
      quote: quoteOf({ maxOutputTokens: 8000 }),
    });
    expect(out.receipt.usage.outputTokens).toBe(400);
    expect(out.clamps).toEqual([
      { kind: 'evidence_bound', field: 'outputTokens', original: 5000, clamped: 400, bound: 400 },
    ]);
  });

  it('B3 与 B1 叠加取更紧界（cap < 证据）', () => {
    const out = acceptTrustedUsage({
      receipt: { ...receiptOf({ outputTokens: 5000 }), outputEvidenceBytes: 9000 },
      quote: quoteOf({ maxOutputTokens: 300 }),
    });
    expect(out.receipt.usage.outputTokens).toBe(300);
    expect(out.clamps.map((c) => c.kind)).toEqual(['output_cap']);
  });

  it('cached 是 input 子集：先钳 input 再钳 cached', () => {
    const out = acceptTrustedUsage({
      receipt: receiptOf({ inputTokens: 9999, cachedInputTokens: 8888 }),
      quote: quoteOf({ inputUpper: 100 }),
    });
    expect(out.receipt.usage.inputTokens).toBe(100);
    expect(out.receipt.usage.cachedInputTokens).toBe(100);
    expect(out.clamps.map((c) => c.kind).toSorted()).toEqual(['cached_bound', 'input_bound']);
  });

  it('cacheWrite / units 同受输入界/单位界钳制', () => {
    const out = acceptTrustedUsage({
      receipt: receiptOf({ cacheWriteTokens: 7777, units: 99 } as never),
      quote: quoteOf({ inputUpper: 500, unitUpper: 4 }),
    });
    expect(out.receipt.usage.cacheWriteTokens).toBe(500);
    expect((out.receipt.usage as { units?: number }).units).toBe(4);
    expect(out.clamps.map((c) => c.kind).toSorted()).toEqual(['cache_write_bound', 'unit_bound']);
  });

  it('旧数据缺界：quote null / 候选缺位 / 界非正数 → 对应界跳过', () => {
    const r = receiptOf({ inputTokens: 20_000_000, outputTokens: 10_000_000 });
    for (const quote of [
      null,
      undefined,
      { maxOutputTokens: -1, candidates: [] },
      quoteOf({ maxOutputTokens: 0, inputUpper: 0 }),
    ]) {
      const out = acceptTrustedUsage({ receipt: r, quote });
      expect(out.receipt).toBe(r); // 全部界缺省 → 直通
    }
  });

  it('恰好等于界不钳（≤ 语义，零误伤边界）', () => {
    const out = acceptTrustedUsage({
      receipt: { ...receiptOf({ inputTokens: 100, outputTokens: 50 }), outputEvidenceBytes: 50 },
      quote: quoteOf({ maxOutputTokens: 50, inputUpper: 100 }),
    });
    expect(out.receipt).toBeInstanceOf(Object);
    expect(out.clamps).toEqual([]);
  });
});
