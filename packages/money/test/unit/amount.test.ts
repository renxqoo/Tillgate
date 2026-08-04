import { describe, expect, it } from 'vitest';
import { calcAmount, calcAmountExact } from '../../src/amount.js';
import { coefficientToMilli } from '../../src/units.js';

const PRICE = { in: 2000, cache: 200, out: 8000 }; // ¥2 / ¥0.2 / ¥8 每百万

describe('calcAmount', () => {
  it('基准：百万输入 + 百万输出（系数 1.0）= ¥10 = 10000 厘', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(amount).toBe(10_000);
  });

  it('缓存拆分：缓存命中按缓存价计', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 0,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    // (500×2000 + 500×200) / 1e6 = 1.1 → round 1 厘
    expect(amount).toBe(1);
  });

  it('系数 1.5 → 费用 1.5 倍', () => {
    const base = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    const withCoeff = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1500,
    });
    expect(withCoeff).toBe(Math.round(base * 1.5));
  });

  it('舍入边界：半值进一', () => {
    // base×1000/1e9 = 2.5 → round = 3
    const amount = calcAmount({
      inputTokens: 250,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: 10_000,
      cacheInputPrice: 0,
      outputPrice: 0,
      coefficientMilli: 1000,
    });
    expect(amount).toBe(3);
  });

  it('零用量 → 0', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(amount).toBe(0);
  });

  it('量级安全：10M tokens × ¥100/百万 × 系数 1.0 精确', () => {
    const amount = calcAmount({
      inputTokens: 10_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: 100_000,
      cacheInputPrice: 10_000,
      outputPrice: 100_000,
      coefficientMilli: 1000,
    });
    // 1e7 × 1e5 / 1e6 = 1e6 厘 = ¥1000
    expect(amount).toBe(1_000_000);
  });

  it('随机 2000 组与 BigInt 精确计算完全一致（防浮点/舍入偏差）', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const input = {
        inputTokens: Math.floor(rand() * 5_000_000),
        cachedInputTokens: Math.floor(rand() * 2_000_000),
        outputTokens: Math.floor(rand() * 5_000_000),
        inputPrice: Math.floor(rand() * 200_000),
        cacheInputPrice: Math.floor(rand() * 200_000),
        outputPrice: Math.floor(rand() * 200_000),
        coefficientMilli: Math.floor(rand() * 2000) + 1,
      };
      expect(calcAmount(input)).toBe(Number(calcAmountExact(input)));
    }
  });

  it('coefficientToMilli 转换', () => {
    expect(coefficientToMilli(1.0)).toBe(1000);
    expect(coefficientToMilli(1.5)).toBe(1500);
    expect(coefficientToMilli(0.1)).toBe(100);
    expect(coefficientToMilli(0.999)).toBe(999);
  });

  // ---- 异常输入防御（资损防线：绝不允许负金额或反向收费）----

  it('负数 outputTokens → 按 0 计（不允许反向收费/白嫖）', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: -500,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    // 输出按 0 计，仅扣输入：1000×2000/1e6 = 2 厘
    expect(amount).toBe(2);
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('负数 inputTokens → 按 0 计', () => {
    const amount = calcAmount({
      inputTokens: -1000,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('NaN tokens → 按 0 计（不允许 NaN 污染金额）', () => {
    const amount = calcAmount({
      inputTokens: Number.NaN,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(Number.isFinite(amount)).toBe(true);
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('Infinity tokens → 按 0 计（不允许 Infinity 算出超大金额）', () => {
    const amount = calcAmount({
      inputTokens: Number.POSITIVE_INFINITY,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(Number.isFinite(amount)).toBe(true);
  });

  it('负数价格 → 按 0 计（配置错误不允许产生负费用）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: -2000,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('coefficientMilli ≤ 0 → 按 0 计（费率卡配置错误不允许免费）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 0,
    });
    expect(amount).toBe(0);
    const amountNeg = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: -100,
    });
    expect(amountNeg).toBe(0);
  });

  it('cachedInputTokens > inputTokens → cached 夹到 input（不允许负未缓存 + 超大缓存双计）', () => {
    const amount = calcAmount({
      inputTokens: 100,
      cachedInputTokens: 200, // 异常：缓存命中超过总输入
      outputTokens: 0,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficientMilli: 1000,
    });
    // cached 夹到 100：100×200/1e6 = 0.02 → round 0 厘（而不是 200×200 导致多收）
    expect(amount).toBeGreaterThanOrEqual(0);
    expect(amount).toBeLessThanOrEqual(1);
  });

  it('返回值永远 ≥ 0（任何异常输入组合）', () => {
    const pathological = [
      { inputTokens: -1, cachedInputTokens: -1, outputTokens: -1 },
      { inputTokens: NaN, cachedInputTokens: NaN, outputTokens: NaN },
      { inputTokens: Infinity, cachedInputTokens: -Infinity, outputTokens: 0 },
    ];
    for (const t of pathological) {
      const amount = calcAmount({
        ...t,
        inputPrice: -1000,
        cacheInputPrice: -100,
        outputPrice: -5000,
        coefficientMilli: -100,
      });
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(amount)).toBe(true);
    }
  });
});
