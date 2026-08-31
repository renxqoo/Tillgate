/**
 * 计价公式行为规格；含回归用例：calculateRequired 组装路径必须传 cacheWritePrice。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { Decimal } from '../src/domain/money.js';
import { calcAmount, estimateMaxCost, requiredReservation } from '../src/domain/rating/pricing.js';
import { calculateFundingReservation, calculateRequired } from '../src/domain/rating/calculate.js';
import { computeAmounts } from '../src/domain/rating/amounts.js';
import { candidate, quote } from './rating-fixtures.js';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection (${code})`);
  expect((caught as { code: string }).code).toBe(code);
}

describe('calcAmount（实扣口径）', () => {
  it('基础：uncached×输入价 + cached×缓存价 + 输出×输出价，除以 1M 乘系数', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 200_000,
      inputPrice: '2',
      cacheInputPrice: '1',
      outputPrice: '6',
      coefficient: '1.5',
    });
    // (600k×2 + 400k×1 + 200k×6)/1M = 2.8 → ×1.5 = 4.2
    expect(amount.toString()).toBe('4.2');
  });

  it('单位计费（按次/张/秒）与 token 并存', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 3,
      unitPrice: '0.5',
      coefficient: '2',
    });
    expect(amount.toString()).toBe('3');
  });

  it('cached > input 时夹到 ≤ input（防负未缓存 + 超大缓存双计）', () => {
    const amount = calcAmount({
      inputTokens: 100,
      cachedInputTokens: 500, // 异常上游
      outputTokens: 0,
      inputPrice: '2',
      cacheInputPrice: '1',
      outputPrice: '0',
      coefficient: '1',
    });
    expect(amount.toNumber()).toBe(100 / 1_000_000); // cached 夹到 100，全按缓存价计
  });

  it('负 token / NaN / Infinity 输入全部钳 0', () => {
    const amount = calcAmount({
      inputTokens: -1000,
      cachedInputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      inputPrice: '2',
      cacheInputPrice: '1',
      outputPrice: '6',
      coefficient: '1',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('系数 ≤ 0 钳 0（配置错误不得免费/反向——授权侧另结构拒绝）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '2',
      cacheInputPrice: '2',
      outputPrice: '0',
      coefficient: '-1.5',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('负单价不产生负金额（钳 0 兜底）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '-5',
      cacheInputPrice: '-5',
      outputPrice: '0',
      coefficient: '1',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('全精度不 round（厘级尾差都不丢）', () => {
    const amount = calcAmount({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.002',
      cacheInputPrice: '0.001',
      outputPrice: '0.003',
      coefficient: '1.1',
    });
    expect(amount.toString()).toBe('0.0000000055');
  });
});

describe('cache_write 计价', () => {
  const base = {
    inputTokens: 1000,
    cachedInputTokens: 300,
    outputTokens: 200,
    inputPrice: '1',
    cacheInputPrice: '0.1',
    outputPrice: '2',
    coefficient: '1',
  };

  it('三分段互斥：uncached + cached + write = input；write 分量按 cacheWritePrice 计价', () => {
    const noWrite = calcAmount(base);
    const withWrite = calcAmount({ ...base, cacheWriteTokens: 200, cacheWritePrice: '1.25' });
    const diff = withWrite.minus(noWrite);
    expect(diff.toNumber()).toBeCloseTo(((500 - 700) * 1 + 200 * 1.25) / 1_000_000, 10);
  });

  it('cached + write 超 input 时夹取（防负未缓存与双计）', () => {
    const out = calcAmount({ ...base, cacheWriteTokens: 999_999, cacheWritePrice: '10' });
    expect(out.gte(0)).toBe(true);
    const expected = (300 * 0.1 + 700 * 10 + 200 * 2) / 1_000_000;
    expect(out.toNumber()).toBeCloseTo(expected, 8);
  });

  it('系数作用于全部分量（用户价 = 官方分量和 × 系数）', () => {
    const coeff2 = calcAmount({
      ...base,
      cacheWriteTokens: 200,
      cacheWritePrice: '1.25',
      coefficient: '1.5',
    });
    const coeff1 = calcAmount({
      ...base,
      cacheWriteTokens: 200,
      cacheWritePrice: '1.25',
      coefficient: '1',
    });
    expect(coeff2.toNumber()).toBeCloseTo(coeff1.toNumber() * 1.5, 8);
  });

  it('cacheWritePrice 缺省/0 → 写 token 按输入价计（未配置不得逃逸计费）', () => {
    const zero = calcAmount({ ...base, cacheWriteTokens: 200 });
    const none = calcAmount(base);
    expect(zero.eq(none)).toBe(true);
  });

  it('estimateMaxCost：cacheWrite 超输入价时进贵价（Anthropic 1.25×/2×）', () => {
    const plain = estimateMaxCost({
      estimatedInputTokens: 1000,
      maxOutputTokens: 0,
      inputPrice: '1',
      outputPrice: '0',
      coefficient: '1',
    });
    const withWrite = estimateMaxCost({
      estimatedInputTokens: 1000,
      maxOutputTokens: 0,
      inputPrice: '1',
      cacheWritePrice: '2',
      outputPrice: '0',
      coefficient: '1',
    });
    expect(withWrite.toNumber()).toBeCloseTo(plain.toNumber() * 2, 8);
  });
});

describe('estimateMaxCost（预扣口径）', () => {
  it('输入按两种输入单价中较贵者（缓存命中量未知）', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 0,
      inputPrice: '2',
      cacheInputPrice: '1', // 便宜——不该被用来省押金
      outputPrice: '0',
      coefficient: '1',
    });
    expect(estimate.toString()).toBe('2');
  });

  it('输出按 max_tokens 上界全额预估', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 500_000,
      inputPrice: '2',
      cacheInputPrice: '2',
      outputPrice: '6',
      coefficient: '1',
    });
    expect(estimate.toString()).toBe('3');
  });

  it('非法系数返回 0（由 calculateRequired 后续结构拒绝）', () => {
    expect(
      estimateMaxCost({
        estimatedInputTokens: 100,
        maxOutputTokens: 0,
        inputPrice: '2',
        outputPrice: '0',
        coefficient: '0',
      }).isZero(),
    ).toBe(true);
  });
});

describe('requiredReservation（单请求上限闸）', () => {
  it('限额内原样返回（绝不截断）', () => {
    expect(requiredReservation('2.5', '10').toString()).toBe('2.5');
    expect(requiredReservation('10', '10').toString()).toBe('10');
  });

  it('超限拒绝（reservation_limit_exceeded）', () => {
    expectCode(() => requiredReservation('10.01', '10'), 'billing.reservation_limit_exceeded');
  });

  it('非法估计/非法限额拒绝', () => {
    expectCode(() => requiredReservation('-1', '10'), 'billing.invalid_reservation_estimate');
    expectCode(() => requiredReservation('1', '0'), 'billing.invalid_reservation_limit');
  });

  it('金额精度不受 Decimal 默认 20 位影响（precision 40）', () => {
    const tiny = new Decimal('0.000000000000000000123456');
    expect(requiredReservation(tiny, '1').toString()).toBe('0.000000000000000000123456');
  });
});

describe('calculateRequired（四道保守）', () => {
  it('最坏 = 输入上界×贵输入价 + maxOutputTokens×输出价，×系数', () => {
    const required = calculateRequired(quote([candidate()]), '100');
    // (1M×2 + 200k×6)/1M = 3.2
    expect(required.toString()).toBe('3.2');
  });

  it('候选链取最贵（fallback 更贵不得透支）', () => {
    const required = calculateRequired(
      quote([candidate(), candidate({ mappingId: 2, inputPrice: '4', outputPrice: '10' })]),
      '100',
    );
    // (1M×4 + 200k×10)/1M = 6
    expect(required.toString()).toBe('6');
  });

  it('B2 回归：候选带 cacheWritePrice 时进入贵价口径（组装路径不漏传）', () => {
    const plain = calculateRequired(quote([candidate()]), '100');
    // 写价 4 > 输入价 2 → 输入按 4 计：(1M×4 + 200k×6)/1M = 5.2
    const withWrite = calculateRequired(quote([candidate({ cacheWritePrice: '4' })]), '100');
    expect(withWrite.toString()).toBe('5.2');
    expect(withWrite.gt(plain)).toBe(true);
  });

  it('explicitlyFree：全零价 → 0 元授权', () => {
    const required = calculateRequired(
      quote([candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })], true),
      '100',
    );
    expect(required.isZero()).toBe(true);
  });

  it('R6：声明免费却有价 → 结构性拒绝（含 cacheWritePrice 口径）', () => {
    expectCode(() => calculateRequired(quote([candidate()], true), '100'), 'billing.invalid_quote');
    expectCode(
      () =>
        calculateRequired(
          quote(
            [
              candidate({
                inputPrice: '0',
                outputPrice: '0',
                cacheInputPrice: '0',
                cacheWritePrice: '2',
              }),
            ],
            true,
          ),
          '100',
        ),
      'billing.invalid_quote',
    );
  });

  it('零价未声明免费 → 拒绝（免费额度印刷机防线）', () => {
    expectCode(
      () =>
        calculateRequired(
          quote([candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })]),
          '100',
        ),
      'billing.invalid_quote',
    );
  });

  it('系数非法 / 价格为负 / 空候选 → 配置错误', () => {
    expectCode(
      () => calculateRequired(quote([candidate({ coefficient: '0' })]), '100'),
      'billing.invalid_coefficient',
    );
    expectCode(
      () => calculateRequired(quote([candidate({ inputPrice: '-1' })]), '100'),
      'billing.invalid_quote',
    );
    expectCode(() => calculateRequired(quote([]), '100'), 'billing.invalid_quote');
  });

  it('超单请求上限 → reservation_limit_exceeded（只拒绝不截断）', () => {
    expectCode(
      () => calculateRequired(quote([candidate()]), '1'),
      'billing.reservation_limit_exceeded',
    );
  });
});

describe('calculateFundingReservation（预扣策略）', () => {
  it('full（缺省）冻结完整预估；fixed 只冻显式门槛；预估 0 时 fixed 也 0', () => {
    expect(calculateFundingReservation('3.5').toString()).toBe('3.5');
    expect(calculateFundingReservation('3.5', { mode: 'fixed', amount: '0.1' }).toString()).toBe(
      '0.1',
    );
    expect(calculateFundingReservation('0', { mode: 'fixed', amount: '0.1' }).toString()).toBe('0');
  });

  it('非法预估 / 非法 fixed 门槛 → 配置错误', () => {
    expectCode(() => calculateFundingReservation('-1'), 'billing.invalid_quote');
    expectCode(
      () => calculateFundingReservation('3.5', { mode: 'fixed', amount: '0' }),
      'billing.invalid_reservation_balance',
    );
  });
});

describe('computeAmounts（结算双口径）', () => {
  it('calculated × 系数；upstreamCost 系数恒 1（官方价口径）', () => {
    const c = candidate({ coefficient: '1.5' });
    const amounts = computeAmounts({
      ...require0(c),
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    });
    expect(amounts.calculatedAmount).toBe('3');
    expect(amounts.upstreamCost).toBe('2');
  });

  it('costPrices 覆盖：upstreamCost 换成本轴，calculated 仍按用户价（双轨定价）', () => {
    const c = candidate({ inputPrice: '2', outputPrice: '4', coefficient: '1' });
    const amounts = computeAmounts({
      ...require0(c),
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        estimated: false,
      },
      costPrices: {
        inputPrice: '0.5',
        cacheInputPrice: '0.5',
        cacheWritePrice: '0',
        outputPrice: '1',
        unitPrice: '0',
      },
    });
    // 用户轴：2×1M + 4×1M（百万价）= 6；成本轴：0.5 + 1 = 1.5（免费/折扣渠道敞口按实价）
    expect(amounts.calculatedAmount).toBe('6');
    expect(amounts.upstreamCost).toBe('1.5');
  });

  it('costPrices 全零 = 免费渠道：成本恒 0，用户侧照常计价', () => {
    const c = candidate({ inputPrice: '2', outputPrice: '2' });
    const amounts = computeAmounts({
      ...require0(c),
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        estimated: false,
      },
      costPrices: {
        inputPrice: '0',
        cacheInputPrice: '0',
        cacheWritePrice: '0',
        outputPrice: '0',
        unitPrice: '0',
      },
    });
    expect(amounts.calculatedAmount).toBe('4');
    expect(amounts.upstreamCost).toBe('0');
  });

  it('负成本钳 0（防御口径共用）', () => {
    const c = candidate({ inputPrice: '-5', outputPrice: '0', cacheInputPrice: '0' });
    const amounts = computeAmounts({
      ...require0(c),
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    });
    expect(amounts.calculatedAmount).toBe('0');
    expect(amounts.upstreamCost).toBe('0');
  });
});

function require0(c: ReturnType<typeof candidate>) {
  return {
    requestId: 'r1',
    userId: 1,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: c.externalModel,
    realModel: c.realModel,
    channelId: null,
    channelKey: 't',
    inputPrice: c.inputPrice,
    outputPrice: c.outputPrice,
    cacheInputPrice: c.cacheInputPrice,
    unitPrice: c.unitPrice,
    coefficient: c.coefficient,
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: c.mappingId,
    billingPolicyFingerprint: c.billingPolicyFingerprint,
  };
}
