/**
 * 策略注册表行为规格（计量/定价策略/预扣策略/系数挑选——迁移自旧仓对应测试，
 * 按源语义改写；错误断言换目录码）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { measurementOf, MEASUREMENTS } from '../src/domain/rating/measurement.js';
import { strategyOf } from '../src/domain/rating/pricing-strategy.js';
import { reservationStrategyOf } from '../src/domain/rating/reservation-strategy.js';
import { pickCoefficient } from '../src/domain/rating/coefficient.js';
import type { PricingContext } from '../src/domain/rating/pricing-strategy.js';

function ctx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    units: 1,
    body: { size: 'hd', quality: 'high' },
    config: {},
    fallbackUnitPrice: '0.1',
    ...overrides,
  };
}

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

describe('measurement（层 1 计量维度）', () => {
  it('token 恒 0（不走单位轴）；request 恒 1', () => {
    expect(MEASUREMENTS.token!.unitsUpperBoundOf({ n: 5 })).toBe(0);
    expect(MEASUREMENTS.request!.unitsOf({})).toBe(1);
  });

  it('image：上界 = n（钳 16，缺省 1）；实值 = 响应张数兜底 n，最少 1', () => {
    const image = measurementOf('image');
    expect(image.unitsUpperBoundOf({ n: 3 })).toBe(3);
    expect(image.unitsUpperBoundOf({ n: 99 })).toBe(16);
    expect(image.unitsUpperBoundOf({})).toBe(1);
    expect(image.unitsUpperBoundOf({ n: 'x' })).toBe(1);
    expect(image.unitsOf({ n: 2 }, { data: [1, 2, 3] })).toBe(3);
    expect(image.unitsOf({ n: 2 }, { data: [] })).toBe(2);
    expect(image.unitsOf({}, undefined)).toBe(1);
  });

  it('second：audioSeconds（向上取整）优先于 duration（钳 4-15 缺省 6——new-api #5498 少押教训）', () => {
    const second = measurementOf('second');
    expect(second.unitsUpperBoundOf({ audioSeconds: 3.2 })).toBe(4);
    expect(second.unitsUpperBoundOf({ duration: 30 })).toBe(15);
    expect(second.unitsUpperBoundOf({ duration: 1 })).toBe(4);
    expect(second.unitsUpperBoundOf({})).toBe(6);
    expect(second.unitsUpperBoundOf({ audioSeconds: 3.2, duration: 30 })).toBe(4);
  });

  it('char：码点口径（emoji 不拆半）', () => {
    expect(measurementOf('char').unitsOf({ input: 'a👍b' })).toBe(3);
    expect(measurementOf('char').unitsOf({})).toBe(0);
  });

  it('未知单位按次兜底', () => {
    expect(measurementOf('byte').unitsOf({})).toBe(1);
  });

  it('注册表全量直调（token/request 恒值轴）', () => {
    expect(MEASUREMENTS.token!.unitsUpperBoundOf({ n: 9 })).toBe(0);
    expect(MEASUREMENTS.token!.unitsOf({}, {})).toBe(0);
    expect(MEASUREMENTS.request!.unitsUpperBoundOf({ n: 9 })).toBe(1);
    expect(MEASUREMENTS.request!.unitsOf({}, {})).toBe(1);
    expect(MEASUREMENTS.char!.unitsUpperBoundOf({ input: 'ab' })).toBe(2);
    expect(MEASUREMENTS.second!.unitsOf({ audioSeconds: 2.1 })).toBe(3);
  });

  it('second：audioSeconds 非法回退 duration；响应缺 data 时 image 用请求 n', () => {
    const second = measurementOf('second');
    expect(second.unitsUpperBoundOf({ audioSeconds: -3, duration: 8 })).toBe(8);
    expect(second.unitsUpperBoundOf({ audioSeconds: 'x', duration: 7.6 })).toBe(8);
    const image = measurementOf('image');
    expect(image.unitsOf({ n: 4 }, {})).toBe(4);
    expect(image.unitsOf({ n: 4 }, { data: 'not-array' })).toBe(4);
  });
});

describe('pricing-strategy（层 2 定价策略）', () => {
  it('flat（缺省/未知策略名）：params.unitPrice 或回落列单价', () => {
    const flat = strategyOf({});
    expect(flat.estimateUnitPrice(ctx())).toBe('0.1');
    expect(flat.settleUnitPrice(ctx({ config: { params: { unitPrice: '0.3' } } }))).toBe('0.3');
    expect(strategyOf({ strategy: 'nonexistent' })).toBe(strategyOf({}));
  });

  it('variant：组合键选价；estimate 未命中取最高价（保守），settle 回落缺省', () => {
    const config = {
      strategy: 'variant',
      params: {
        selector: 'size:quality',
        prices: { 'hd:high': '0.4', 'std:low': '0.05' },
        unitPrice: '0.2',
      },
    };
    const variant = strategyOf({ strategy: 'variant' });
    // 命中
    expect(variant.settleUnitPrice(ctx({ config }))).toBe('0.4');
    expect(variant.estimateUnitPrice(ctx({ config }))).toBe('0.4');
    // 未命中：estimate 最高价 0.4；settle 回落 0.2
    const miss = ctx({ config, body: { size: 'std' } });
    expect(variant.estimateUnitPrice(miss)).toBe('0.4');
    expect(variant.settleUnitPrice(miss)).toBe('0.2');
    // 无价格表 → 回落列单价
    expect(variant.estimateUnitPrice(ctx({ config: { strategy: 'variant' } }))).toBe('0.1');
  });
});

describe('reservation-strategy（层 3 预扣策略）', () => {
  it('full（缺省）不干预', () => {
    expect(reservationStrategyOf({}).unitFloorOf({})).toBeNull();
    expect(
      reservationStrategyOf({ strategy: 'full' }).unitFloorOf({ params: { units: 5 } }),
    ).toBeNull();
  });

  it('floor：units 正整数保底；声明了但非法 = 配置事故', () => {
    expect(reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 5 } })).toBe(
      5,
    );
    expect(reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({})).toBeNull();
    expectCode(
      () => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 0 } }),
      'billing.invalid_reservation_units',
    );
    expectCode(
      () => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 1.5 } }),
      'billing.invalid_reservation_units',
    );
  });

  it('未知策略名 = 配置事故（与定价策略的 flat 兜底刻意不同）', () => {
    expectCode(
      () => reservationStrategyOf({ strategy: 'fraction' }),
      'billing.unknown_reservation_strategy',
    );
  });
});

describe('pickCoefficient（费率卡系数）', () => {
  const snapshot = {
    rateCardId: 1,
    status: 0,
    global: '1.2',
    model: { 7: '0.8' },
    group: { vip: '0.9' },
  };

  it('优先级 model > group > global > 无卡恒 1', () => {
    expect(pickCoefficient(snapshot, { modelMappingId: 7, pricingGroup: 'vip' })).toBe('0.8');
    expect(pickCoefficient(snapshot, { modelMappingId: 8, pricingGroup: 'vip' })).toBe('0.9');
    expect(pickCoefficient(snapshot, { modelMappingId: 8, pricingGroup: 'other' })).toBe('1.2');
    expect(pickCoefficient(null, { modelMappingId: 7, pricingGroup: 'vip' })).toBe('1');
  });

  it('global 缺省回落 1', () => {
    expect(
      pickCoefficient({ ...snapshot, global: null }, { modelMappingId: 8, pricingGroup: null }),
    ).toBe('1');
  });
});
