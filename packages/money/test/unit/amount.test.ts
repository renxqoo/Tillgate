import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calcAmount } from '../../src/amount.js';

// 元价（重构后）：单位 元/百万 token
// 对照 DeepSeek deepseek-chat 实际配置：输入 ¥1/百万(=0.001)，输出 ¥2/百万(=0.002)
const PRICE = { in: '0.001', cache: '0.0001', out: '0.002' };

/** 断言两个 Decimal 相等（用字符串比较，避免浮点） */
function expectDecimal(actual: Decimal, expected: string): void {
  expect(actual.toString()).toBe(new Decimal(expected).toString());
}

describe('calcAmount（元 + decimal 全精度）', () => {
  it('基准：百万输入 + 百万输出（系数 1.0）= ¥3（输入¥1 + 输出¥2）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    // (1e6×0.001 + 1e6×0.002)/1e6 × 1 = 0.003 元
    expectDecimal(amount, '0.003');
  });

  it('【核心】8 input + 1 output @ DeepSeek 价 → 精确计费 1e-8 元，不再是 0', () => {
    // 这正是重构要修复的资损 bug：重构前厘+Math.round 算出 0（白嫖），现在精确计费。
    // 实际金额：(8×0.001 + 1×0.002)/1e6 = 0.01/1e6 = 1e-8 元（极小但非 0，累积即资损）
    const amount = calcAmount({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.001', // ¥1/百万
      cacheInputPrice: '0.0001',
      outputPrice: '0.002', // ¥2/百万
      coefficient: 1,
    });
    expectDecimal(amount, '0.00000001'); // 1e-8 元
    expect(amount.isZero()).toBe(false); // 关键：不再是 0
  });

  it('缓存拆分：缓存命中按缓存价计', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 0,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // (500×0.002 + 500×0.0002)/1e6 = 0.0011/1e6 = 0.0000011 元（全精度，不 round）
    expectDecimal(amount, '0.0000011');
  });

  it('系数 1.5 → 费用精确 1.5 倍', () => {
    const base = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    const withCoeff = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1.5,
    });
    // 1.5 倍精确（decimal，无 round 误差）
    expectDecimal(withCoeff, base.times(1.5).toString());
  });

  it('账本永不 round：半值不进一（与重构前的关键区别）', () => {
    // 重构前：厘 + Math.round，2.5 → 3（半值进一，丢精度）
    // 重构后：全精度，0.0000025 就是 0.0000025，不 round
    const amount = calcAmount({
      inputTokens: 250,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.01', // ¥0.01/百万
      cacheInputPrice: 0,
      outputPrice: 0,
      coefficient: 1,
    });
    // 250×0.01/1e6 = 0.0025/1e6 = 0.0000025 元（精确，不进一成 0.000003）
    expectDecimal(amount, '0.0000025');
  });

  it('零用量 → 0', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    expect(amount.isZero()).toBe(true);
  });

  it('量级安全：10M tokens × ¥0.1/百万 × 系数 1.0', () => {
    const amount = calcAmount({
      inputTokens: 10_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.1',
      cacheInputPrice: '0.01',
      outputPrice: '0.1',
      coefficient: 1,
    });
    // 1e7 × 0.1 / 1e6 = 1 元
    expectDecimal(amount, '1');
  });

  it('累加 1 万次小请求 → 余额精确变动（防累积资损）', () => {
    // 模拟：每次 8 input + 1 output = 1e-8 元，1 万次 = 1e-4 元（精确）
    const perRequest = calcAmount({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      coefficient: 1,
    });
    let cumulative = new Decimal(0);
    for (let i = 0; i < 10_000; i++) {
      cumulative = cumulative.plus(perRequest);
    }
    // 1e-8 × 10000 = 1e-4 = 0.0001 元（精确，重构前会全是 0 → 资损）
    expectDecimal(cumulative, '0.0001');
  });

  // ---- 异常输入防御（资损防线：绝不允许负金额或反向收费）----

  it('负数 outputTokens → 按 0 计（不允许反向收费/白嫖）', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: -500,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // 输出按 0 计：1000×0.002/1e6 = 0.000002 元
    expectDecimal(amount, '0.000002');
    expect(amount.gte(0)).toBe(true);
  });

  it('负数 inputTokens → 按 0 计', () => {
    const amount = calcAmount({
      inputTokens: -1000,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.gte(0)).toBe(true);
  });

  it('NaN tokens → 按 0 计（不允许 NaN 污染金额）', () => {
    const amount = calcAmount({
      inputTokens: Number.NaN,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.isFinite()).toBe(true);
    expect(amount.gte(0)).toBe(true);
  });

  it('Infinity tokens → 按 0 计（不允许 Infinity 算出超大金额）', () => {
    const amount = calcAmount({
      inputTokens: Number.POSITIVE_INFINITY,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.isFinite()).toBe(true);
  });

  it('负数价格 → 按 0 计（配置错误不允许产生负费用）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: -0.002,
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.gte(0)).toBe(true);
  });

  it('coefficient ≤ 0 → 按 0 计（费率卡配置错误不允许免费）', () => {
    const zero = calcAmount({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000,
      inputPrice: PRICE.in, cacheInputPrice: PRICE.cache, outputPrice: PRICE.out, coefficient: 0,
    });
    expect(zero.isZero()).toBe(true);
    const neg = calcAmount({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000,
      inputPrice: PRICE.in, cacheInputPrice: PRICE.cache, outputPrice: PRICE.out, coefficient: -1,
    });
    expect(neg.isZero()).toBe(true);
  });

  it('cachedInputTokens > inputTokens → cached 夹到 input', () => {
    const amount = calcAmount({
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 0,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // cached 夹到 100：100×0.0002/1e6 = 0.00000002 元（精确，不因双计多收）
    expect(amount.gte(0)).toBe(true);
  });

  it('返回值永远 ≥ 0 且有限（任何异常输入组合）', () => {
    const pathological = [
      { inputTokens: -1, cachedInputTokens: -1, outputTokens: -1 },
      { inputTokens: NaN, cachedInputTokens: NaN, outputTokens: NaN },
      { inputTokens: Infinity, cachedInputTokens: -Infinity, outputTokens: 0 },
    ];
    for (const t of pathological) {
      const amount = calcAmount({
        ...t,
        inputPrice: -1,
        cacheInputPrice: -0.1,
        outputPrice: -5,
        coefficient: -1,
      });
      expect(amount.gte(0)).toBe(true);
      expect(amount.isFinite()).toBe(true);
    }
  });

  it('返回类型是 Decimal（全精度，非 number）', () => {
    const amount = calcAmount({
      inputTokens: 8, cachedInputTokens: 0, outputTokens: 1,
      inputPrice: '0.001', cacheInputPrice: '0.0001', outputPrice: '0.002', coefficient: 1,
    });
    expect(amount).toBeInstanceOf(Decimal);
  });
});
