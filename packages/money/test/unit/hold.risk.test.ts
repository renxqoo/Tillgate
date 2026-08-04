import { describe, expect, it } from 'vitest';
import { estimateMaxCost } from '../../src/hold.js';
import { PRICE_PER_MILLION, COEFFICIENT_SCALE } from '../../src/units.js';

/**
 * TDD 红灯：estimateMaxCost 应对非有限输入做防御（safe 守卫）。
 *
 * 定位：packages/money/src/hold.ts:18-22
 *   base = in * inPrice + out * outPrice
 *   Math.round((base * coefficientMilli) / (PRICE_PER_MILLION * COEFFICIENT_SCALE))
 *
 * 期望（安全行为）：
 *   估算金额用于 Redis INCRBY / DB 扣费，必须是有限非负整数。
 *   任何 Infinity / NaN / 负数入参，函数应：
 *     - 要么返回有限安全值（如 0 / 夹紧），要么抛业务错；
 *     绝不能把 Infinity / NaN 漏给下游（INCRBY 抛错 → 漏扣；NaN 写库 → 账本污染）。
 *
 * 当前实现无任何守卫，这些断言全部报红 = 风险确认存在。
 * 补上 safe() 后（如夹紧到 0 或抛错），对应断言转绿。
 *
 * 副作用链：estimateMaxCost → calcHold(Infinity/NaN) → Redis INCRBY / DB。
 *          callers：chat-completions.ts:187、embeddings.ts:68 直接传入估算值。
 */

const NORMAL = {
  estimatedInputTokens: 1_000_000,
  maxOutputTokens: 4096,
  inputPrice: 2000,
  outputPrice: 8000,
  coefficientMilli: 1000,
} as const;

describe('estimateMaxCost 应防御非有限输入（红灯 = 风险确认）', () => {
  it('基线：正常输入返回有限正整数', () => {
    const cost = estimateMaxCost({ ...NORMAL });
    expect(Number.isFinite(cost)).toBe(true);
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it('estimatedInputTokens = Infinity → 期望结果有限（当前返回 Infinity → 红）', () => {
    const cost = estimateMaxCost({ ...NORMAL, estimatedInputTokens: Infinity });
    expect(Number.isFinite(cost), 'Infinity 入参不应漏出，必须被防御').toBe(true);
  });

  it('maxOutputTokens = Infinity（攻击者 max_tokens=Infinity）→ 期望结果有限（红）', () => {
    const cost = estimateMaxCost({ ...NORMAL, maxOutputTokens: Infinity });
    expect(Number.isFinite(cost), 'max_tokens=Infinity 不应导致估算炸裂').toBe(true);
  });

  it('inputPrice = Infinity（配置/数据错误）→ 期望结果有限（红）', () => {
    const cost = estimateMaxCost({ ...NORMAL, inputPrice: Infinity });
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('coefficientMilli = Infinity → 期望结果有限（红）', () => {
    const cost = estimateMaxCost({ ...NORMAL, coefficientMilli: Infinity });
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('任一输入为 NaN → 期望结果有限（当前返回 NaN → 红）', () => {
    expect(estimateMaxCost({ ...NORMAL, estimatedInputTokens: NaN })).not.toBeNaN();
    expect(estimateMaxCost({ ...NORMAL, maxOutputTokens: NaN })).not.toBeNaN();
    expect(estimateMaxCost({ ...NORMAL, inputPrice: NaN })).not.toBeNaN();
    expect(estimateMaxCost({ ...NORMAL, coefficientMilli: NaN })).not.toBeNaN();
  });

  it('负数输入 → 期望结果非负（当前返回负数 → 红）', () => {
    const cost = estimateMaxCost({ ...NORMAL, estimatedInputTokens: -1_000_000 });
    expect(cost, '估算金额必须非负，负值会走 calcHold 取到负 hold').toBeGreaterThanOrEqual(0);
  });

  it('下游 calcHold 对 NaN 估算应有限（当前 NaN 污染全链路 → 红）', async () => {
    const { calcHold } = await import('../../src/hold.js');
    const nanEstimate = estimateMaxCost({ ...NORMAL, inputPrice: NaN });
    const hold = calcHold(nanEstimate, 5000, 50_000);
    expect(Number.isFinite(hold), 'NaN 估算不应污染 hold 金额').toBe(true);
  });
});

describe('常量约束自检（辅助）', () => {
  it('PRICE_PER_MILLION 与 COEFFICIENT_SCALE 均为有限正整数', () => {
    expect(Number.isFinite(PRICE_PER_MILLION)).toBe(true);
    expect(PRICE_PER_MILLION).toBeGreaterThan(0);
    expect(Number.isFinite(COEFFICIENT_SCALE)).toBe(true);
    expect(COEFFICIENT_SCALE).toBeGreaterThan(0);
  });
});
