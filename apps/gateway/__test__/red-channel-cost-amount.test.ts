/**
 * 渠道预算闸门金额口径（2026-08-30/31 生产事故已修复转绿——原红测承载）：
 *
 * gateway billing-port channelCostAmount → billing estimateMaxCost：
 *   amount = max(input, cacheInput, cacheWrite) × estimatedInputTokens/1e6
 *          + output × maxOutputTokens/1e6（coefficient=1）
 *
 * 【修复】渠道成本面缺失（绑定五轴全 NULL 未标 free → costPrices undefined）时
 * amount = '0'（闸门不预扣不拒绝，与结算口径同源——结算对未配置成本按 0 扣减）。
 * 旧口径静默继承用户卖价 + 字节上界 → 1MB 请求敞口 $2.13，双渠道余额全拒 503。
 */
import { describe, expect, it } from 'vitest';
import type { QuoteCandidate } from '@tillgate/inference';
import { createGatewayBilling } from '../src/adapters/billing-port';

function candidate(overrides: Partial<QuoteCandidate>): QuoteCandidate {
  return {
    mappingId: 1,
    externalModel: 'minimax-m3',
    realModel: 'minimax/minimax-m3:free',
    inputPrice: '2',
    cacheInputPrice: '0.4',
    cacheWritePrice: null,
    outputPrice: '8',
    unitPrice: null,
    pricingUnit: 'token',
    unitUpperBound: 0,
    coefficient: '1',
    billingPolicyFingerprint: null,
    ...overrides,
  };
}

/** 显式配置的成本五轴（绑定列有值——修复后参与预算管控） */
const configuredCost = {
  inputPrice: '2',
  cacheInputPrice: '0.4',
  cacheWritePrice: '0',
  outputPrice: '8',
  unitPrice: '0',
};

/** cost_is_free 物化结果（catalog-port costPricesOf——全 0 成本轴） */
const freeCost = {
  inputPrice: '0',
  cacheInputPrice: '0',
  cacheWritePrice: '0',
  outputPrice: '0',
  unitPrice: '0',
};

function harness() {
  const amounts: string[] = [];
  const port = createGatewayBilling(
    {
      authorize: async () => {},
      signal: async () => {},
      reserveChannel: async (input) => {
        amounts.push(input.amount);
        return { allowed: true, remaining: '0', switched: false };
      },
    },
    {
      resolveReservationLimit: async () => '10',
      resolveReservationPolicy: async () => ({ mode: 'full' }),
    },
  );
  return { port, amounts };
}

const PROD_INPUT = {
  requestId: 'req-cost-scope',
  channelId: 2,
  candidate: candidate({}),
  estimatedInputTokens: 1_048_576,
  maxOutputTokens: 4_096,
};

describe('渠道预算闸门金额口径（生产事故修复锁定）', () => {
  it('修复锁定：成本面缺失（undefined）→ amount = 0（旧口径按卖价×字节算 $2.13 全拒双渠道）', async () => {
    const { port, amounts } = harness();
    await port.reserveChannel({ ...PROD_INPUT }); // 不传 costPrices = 成本面缺失
    expect(Number(amounts[0])).toBe(0);
  });

  it('cost_is_free 渠道物化全 0 成本 → 敞口 0（能力不变）', async () => {
    const { port, amounts } = harness();
    await port.reserveChannel({ ...PROD_INPUT, costPrices: freeCost });
    expect(Number(amounts[0])).toBe(0);
  });

  it('已配置成本的渠道：按配置价 × 字节保守上界（amount = 2.12992——资金面不放松）', async () => {
    const { port, amounts } = harness();
    await port.reserveChannel({ ...PROD_INPUT, costPrices: configuredCost });
    expect(Number(amounts[0])).toBeCloseTo(2.12992, 6);
  });

  it('字节口径保守性锁定（绿）：同请求字节口径敞口 ≈ token 口径 3.85 倍（结算不变式的结构保证）', async () => {
    const { port, amounts } = harness();
    await port.reserveChannel({
      ...PROD_INPUT,
      estimatedInputTokens: 260_000,
      costPrices: configuredCost,
    });
    const tokenScope = Number(amounts[0]);
    await port.reserveChannel({
      ...PROD_INPUT,
      estimatedInputTokens: 1_048_576,
      costPrices: configuredCost,
    });
    const byteScope = Number(amounts[1]);
    // 精确比值 (2×1_048_576+8×4_096)/(2×260_000+8×4_096) ≈ 3.85（输出项不随口径变）
    expect(byteScope / tokenScope).toBeGreaterThan(3.8);
  });
});
