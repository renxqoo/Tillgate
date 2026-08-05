import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { estimateMaxCost } from '../../src/hold.js';
import { PRICE_PER_MILLION } from '../../src/units.js';

/**
 * estimateMaxCost 应防御非有限输入（safe 守卫）—— decimal 重构版。
 *
 * 估算金额用于 DB 扣费，必须是有限非负 Decimal。
 * 任何 Infinity / NaN / 负数入参，函数应夹紧到安全值（0），绝不漏给下游。
 */

const NORMAL = {
  estimatedInputTokens: 1_000_000,
  maxOutputTokens: 4096,
  inputPrice: '0.002',
  outputPrice: '0.008',
  coefficient: 1,
} as const;

describe('estimateMaxCost 应防御非有限输入（decimal 版）', () => {
  it('基线：正常输入返回有限正 Decimal', () => {
    const cost = estimateMaxCost({ ...NORMAL });
    expect(cost.isFinite()).toBe(true);
    expect(cost.gt(0)).toBe(true);
    expect(cost).toBeInstanceOf(Decimal);
  });

  it('estimatedInputTokens = Infinity → 结果有限', () => {
    const cost = estimateMaxCost({ ...NORMAL, estimatedInputTokens: Infinity });
    expect(cost.isFinite(), 'Infinity 入参不应漏出').toBe(true);
  });

  it('maxOutputTokens = Infinity（攻击者 max_tokens=Infinity）→ 结果有限', () => {
    const cost = estimateMaxCost({ ...NORMAL, maxOutputTokens: Infinity });
    expect(cost.isFinite()).toBe(true);
  });

  it('inputPrice = Infinity（配置错误）→ 结果有限', () => {
    const cost = estimateMaxCost({ ...NORMAL, inputPrice: Infinity });
    expect(cost.isFinite()).toBe(true);
  });

  it('coefficient = Infinity → 结果有限', () => {
    const cost = estimateMaxCost({ ...NORMAL, coefficient: Infinity });
    expect(cost.isFinite()).toBe(true);
  });

  it('任一输入为 NaN → 结果有限', () => {
    expect(estimateMaxCost({ ...NORMAL, estimatedInputTokens: NaN }).isFinite()).toBe(true);
    expect(estimateMaxCost({ ...NORMAL, maxOutputTokens: NaN }).isFinite()).toBe(true);
    expect(estimateMaxCost({ ...NORMAL, inputPrice: NaN }).isFinite()).toBe(true);
    expect(estimateMaxCost({ ...NORMAL, coefficient: NaN }).isFinite()).toBe(true);
  });

  it('负数输入 → 结果非负', () => {
    const cost = estimateMaxCost({ ...NORMAL, estimatedInputTokens: -1_000_000 });
    expect(cost.gte(0), '估算金额必须非负').toBe(true);
  });

  it('下游 calcHold 对异常估算应有限', async () => {
    const { calcHold } = await import('../../src/hold.js');
    const badEstimate = estimateMaxCost({ ...NORMAL, inputPrice: NaN });
    const hold = calcHold(badEstimate, '0.05', '50');
    expect(hold.isFinite(), '异常估算不应污染 hold 金额').toBe(true);
  });
});

describe('常量约束自检（辅助）', () => {
  it('PRICE_PER_MILLION 为有限正整数', () => {
    expect(Number.isFinite(PRICE_PER_MILLION)).toBe(true);
    expect(PRICE_PER_MILLION).toBeGreaterThan(0);
  });
});
