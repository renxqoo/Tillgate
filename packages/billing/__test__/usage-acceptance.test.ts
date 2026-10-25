/**
 * 结算用量验收门：
 * 三界钳制矩阵 / 估算直通 / 旧数据缺界跳过 / 恰好等于界不钳 / 违规事实完整记录。
 */
import { describe, expect, it } from 'vitest';
import { acceptTrustedUsage, isHardViolation } from '../src/domain/rating/usage-acceptance';
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

function quoteOf(bound: {
  maxOutputTokens?: number;
  inputUpper?: number;
  unitUpper?: number;
}): BillingQuote {
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
    const r = receiptOf({
      estimated: true,
      inputTokens: 99_999_999,
      outputTokens: 88_888_888,
    } as never);
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
    expect(out.clamps.find((c) => c.kind === 'input_bound')).toMatchObject({
      original: 20_000_000,
      clamped: 30,
    });
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

describe('钳制分级（缺陷计数只看硬违例——issue #80）', () => {
  it('evidence_bound 是软钳制（隐藏 token 口径非定理，不记缺陷）', () => {
    const out = acceptTrustedUsage({
      receipt: { ...receiptOf({ outputTokens: 5000 }), outputEvidenceBytes: 400 },
      quote: quoteOf({ maxOutputTokens: 8000 }),
    });
    expect(out.clamps).toHaveLength(1);
    expect(out.clamps[0]?.kind).toBe('evidence_bound');
    expect(out.clamps[0] != null && isHardViolation(out.clamps[0])).toBe(false);
  });

  it('B1 缺失时（issue #83）：输出计费候选的证据界升级硬违例；输出免费仍软', () => {
    // quote 无 maxOutputTokens（存量缺界 / embeddings / modality 口径 0）
    const [base] = quoteOf({}).candidates;
    const quoteWithoutCap = (outputPrice: string): BillingQuote =>
      ({
        candidates: [base != null ? { ...base, outputPrice } : { mappingId: 7, outputPrice }],
      }) as unknown as BillingQuote;
    // 输出计费（outputPrice > 0）：超证据字节 → 升级为审计级硬（kind 区分），
    // 但不进缺陷计数（isHardViolation=false——口径非定理性与 B1 无关，pr #85 路 C #1）
    const priced = acceptTrustedUsage({
      receipt: { ...receiptOf({ outputTokens: 5000 }), outputEvidenceBytes: 400 },
      quote: quoteWithoutCap('2'),
    });
    expect(priced.clamps).toHaveLength(1);
    expect(priced.clamps[0]?.kind).toBe('evidence_bound_hard');
    expect(priced.clamps[0] != null && isHardViolation(priced.clamps[0])).toBe(false);

    // 输出免费（outputPrice = 0）：无资金敞口 → 维持软钳（无谓熔断无意义）
    const free = acceptTrustedUsage({
      receipt: { ...receiptOf({ outputTokens: 5000 }), outputEvidenceBytes: 400 },
      quote: quoteWithoutCap('0'),
    });
    expect(free.clamps).toHaveLength(1);
    expect(free.clamps[0]?.kind).toBe('evidence_bound');
    expect(free.clamps[0] != null && isHardViolation(free.clamps[0])).toBe(false);
  });

  it('五类硬界钳制均记缺陷（谎报判定保留）', () => {
    const cases: Array<Parameters<typeof acceptTrustedUsage>[0]> = [
      // output_cap：发票超准入 cap
      {
        receipt: receiptOf({ outputTokens: 5000 }),
        quote: quoteOf({ maxOutputTokens: 300 }),
      },
      // input_bound + cached_bound
      {
        receipt: receiptOf({ inputTokens: 9999, cachedInputTokens: 8888 }),
        quote: quoteOf({ inputUpper: 100 }),
      },
      // cache_write_bound + unit_bound
      {
        receipt: receiptOf({ cacheWriteTokens: 7777, units: 99 } as never),
        quote: quoteOf({ inputUpper: 500, unitUpper: 4 }),
      },
    ];
    const kinds = new Set<string>();
    for (const c of cases) {
      for (const clamp of acceptTrustedUsage(c).clamps) {
        kinds.add(clamp.kind);
        expect(isHardViolation(clamp)).toBe(true);
      }
    }
    expect(kinds).toEqual(
      new Set(['output_cap', 'input_bound', 'cached_bound', 'cache_write_bound', 'unit_bound']),
    );
  });

  it('分级词表封闭：硬违例 = 五类硬界，evidence 唯一软类', () => {
    const all = [
      'output_cap',
      'input_bound',
      'cached_bound',
      'cache_write_bound',
      'unit_bound',
      'evidence_bound',
    ] as const;
    const hard = all.filter((k) =>
      isHardViolation({ kind: k, field: 'outputTokens', original: 2, clamped: 1, bound: 1 }),
    );
    expect(hard).toEqual([
      'output_cap',
      'input_bound',
      'cached_bound',
      'cache_write_bound',
      'unit_bound',
    ]); // evidence_bound / evidence_bound_hard 均为熔断级软（审计级差异在 kind 本身）
  });
});
