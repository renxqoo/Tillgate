/**
 * 预算软水位评分器（2026-08-31 生产事故已修复转绿——原红测承载）：
 *
 * 【事故】budgetWatermarkFactor 分母用 upstreamBudget 列——该列是滚动余额
 * （充值/adjust/消耗直接改写），remaining/budget 恒 ≈1，水位从不生效
 * （生产实况：充值 $1 只剩 6.65% 仍满权重接流量）。
 *
 * 【修复】分母改累计正向充值 upstreamFunded（channel_recharges 聚合，type='recharge'
 * 且 amount>0——adjust 纠偏不入基数）；无充值记录回退 budget 列口径（不参与降权）。
 */
import { describe, expect, it } from 'vitest';
import { budgetWatermarkFactor } from '../src/routing/ranker';

describe('预算软水位评分器：充值基数口径（修复锁定）', () => {
  it('修复锁定：余额占累计充值极低比例的渠道被显著降权（生产实况 funded=1 剩 0.0665）', () => {
    // rolling budget 列口径（budget=remaining）+ funded 锚点 → ratio 0.0665 < 0.2 → 0.33
    expect(
      budgetWatermarkFactor(
        { upstreamBudget: '0.0665', upstreamRemaining: '0.0665', upstreamFunded: '1' },
        0.2,
      ),
    ).toBeCloseTo(0.3325, 4);
  });

  it('水位充足不动权重；真实低于 softRatio 线性降权（字面语义不变）', () => {
    expect(
      budgetWatermarkFactor(
        { upstreamBudget: '10', upstreamRemaining: '5', upstreamFunded: '10' },
        0.2,
      ),
    ).toBe(1);
    expect(
      budgetWatermarkFactor(
        { upstreamBudget: '10', upstreamRemaining: '1', upstreamFunded: '10' },
        0.2,
      ),
    ).toBe(0.5);
  });

  it('无充值记录（funded 缺省/0）回退 budget 列口径——水位不参与，不误伤预算直设渠道', () => {
    // 回退口径下 ratio = remaining/budget；直设渠道两者同源 → 满权重
    expect(
      budgetWatermarkFactor({ upstreamBudget: '0.0665', upstreamRemaining: '0.0665' }, 0.2),
    ).toBe(1);
    expect(
      budgetWatermarkFactor(
        { upstreamBudget: '10', upstreamRemaining: '1', upstreamFunded: '0' },
        0.2,
      ),
    ).toBe(0.5);
  });
});
