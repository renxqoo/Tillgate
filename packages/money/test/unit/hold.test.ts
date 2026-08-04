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
});

describe('calcHold', () => {
  it('min(估算, 余额, HOLD_MAX) 三分支', () => {
    expect(calcHold(100, 50, 1000)).toBe(50); // 余额更小
    expect(calcHold(100, 500, 80)).toBe(80); // HOLD_MAX 更小
    expect(calcHold(100, 500, 1000)).toBe(100); // 估算最小
  });
});
