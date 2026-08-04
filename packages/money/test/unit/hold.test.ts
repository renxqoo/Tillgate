import { describe, expect, it } from 'vitest';
import { calcHold, estimateMaxCost } from '../../src/hold.js';

describe('estimateMaxCost', () => {
  it('基准：估算输入 1M × ¥2 + 输出上限 4096 × ¥8（系数 1.0）', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 4096,
      inputPrice: 2000,
      outputPrice: 8000,
      coefficientMilli: 1000,
    });
    // (1e6×2000 + 4096×8000)/1e6 = 2000 + 32.768 → 2032.768 → round 2033 厘
    expect(cost).toBe(2033);
  });

  it('系数影响估算', () => {
    const base = estimateMaxCost({
      estimatedInputTokens: 100_000,
      maxOutputTokens: 1000,
      inputPrice: 2000,
      outputPrice: 8000,
      coefficientMilli: 1000,
    });
    const fast = estimateMaxCost({
      estimatedInputTokens: 100_000,
      maxOutputTokens: 1000,
      inputPrice: 2000,
      outputPrice: 8000,
      coefficientMilli: 2000,
    });
    expect(fast).toBe(base * 2);
  });

  it('极小输入（1 token × 1000 厘/M）→ 最小返回 1 厘（不 round 到 0 导致误拒）', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 1,
      maxOutputTokens: 0,
      inputPrice: 1000,
      outputPrice: 0,
      coefficientMilli: 1000,
    });
    // 1 × 1000 / 1e6 = 0.001 → round=0，但 base>0 所以最小返回 1
    expect(cost).toBe(1);
  });

  it('所有输入为 0 → 返回 0（无可计费内容）', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      inputPrice: 1000,
      outputPrice: 2000,
      coefficientMilli: 1000,
    });
    expect(cost).toBe(0);
  });
});

describe('calcHold', () => {
  it('min(估算, 余额, HOLD_MAX) 三分支', () => {
    expect(calcHold(100, 50, 1000)).toBe(50); // 余额更小
    expect(calcHold(100, 500, 80)).toBe(80); // HOLD_MAX 更小
    expect(calcHold(100, 500, 1000)).toBe(100); // 估算最小
  });

  it('估算为非有限值（Infinity/NaN/负数）→ 防御为 0（不污染 Redis INCRBY / DB）', () => {
    // 即使上游 estimateMaxCost 漏了防御（历史 bug），calcHold 这层也要兜住
    expect(calcHold(Infinity, 1000, 1000)).toBe(0); // estimate 非有限 → 0
    expect(calcHold(Number.NaN, 1000, 1000)).toBe(0);
    expect(calcHold(-500, 1000, 1000)).toBe(0); // 负估算 → 0（绝不反向）
  });

  it('余额为非有限值 → 防御为 0（拒绝预扣，触发 402）', () => {
    expect(calcHold(1000, Infinity, 1000)).toBe(0);
    expect(calcHold(1000, Number.NaN, 1000)).toBe(0);
    expect(calcHold(1000, -100, 1000)).toBe(0);
  });

  it('HOLD_MAX 为非有限值 → 防御为 0（配置错误不导致无限预扣）', () => {
    expect(calcHold(1000, 1000, Infinity)).toBe(0);
    expect(calcHold(1000, 1000, Number.NaN)).toBe(0);
  });

  it('estimate=0（极小请求）→ 返回 0，不拦截（gateway 层靠 balance 判定是否放行）', () => {
    // estimate=0 + balance>0 → 返回 0（gateway 放行，worker 结算实际扣费）
    expect(calcHold(0, 99962209, 50000)).toBe(0);
    // estimate=0 + balance=0 → 返回 0（gateway 拒绝）
    expect(calcHold(0, 0, 50000)).toBe(0);
  });
});
