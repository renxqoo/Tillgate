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
import {
  minuteOfDayInZone,
  validateScheduleWindows,
  windowLabelOf,
  type PricingWindow,
} from '../src/domain/rating/schedule.js';
import type {
  BillingConfig,
  PricingContext,
} from '../src/domain/rating/pricing-strategy.js';

function ctx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    units: 1,
    body: { size: 'hd', quality: 'high' },
    config: {},
    fallbackUnitPrice: '0.1',
    // 准入时刻与计费时区（schedule 选档维度；固定锚点避免用例随时钟漂移）
    now: new Date('2026-08-24T03:00:00+08:00'),
    timezone: 'Asia/Shanghai',
    ...overrides,
  };
}

/** schedule 策略配置构造（不捕获变量——模块顶层复用） */
const scheduleConfig = (windows: PricingWindow[]): BillingConfig => ({
  strategy: 'schedule',
  params: { windows },
});

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

  it('flat/variant：resolvePriceOverrides 恒 null（透传基价——只有 schedule 产出覆盖）', () => {
    expect(strategyOf({}).resolvePriceOverrides(ctx())).toBeNull();
    expect(
      strategyOf({ strategy: 'variant' }).resolvePriceOverrides(
        ctx({ config: { strategy: 'variant', params: { selector: 'size', prices: { hd: '0.4' } } } }),
      ),
    ).toBeNull();
  });
});

describe('schedule（层 2 分时段定价策略）', () => {
  const windows = [
    { label: '谷时段', start: '18:00', end: '07:00', inputPrice: '1', outputPrice: '4', unitPrice: '0.008' },
  ];

  it('命中窗口：字段级覆盖 + 审计标签；未覆盖轴不出现在覆盖里', () => {
    const strategy = strategyOf({ strategy: 'schedule' });
    const overrides = strategy.resolvePriceOverrides(ctx({ config: scheduleConfig(windows) }));
    expect(overrides).toEqual({
      inputPrice: '1',
      outputPrice: '4',
      unitPrice: '0.008',
      pricingWindow: '谷时段',
    });
    expect(strategy.settleUnitPrice(ctx({ config: scheduleConfig(windows) }))).toBe('0.008');
  });

  it('未命中时段：覆盖为 null，settle 回落基价列（峰时 = 基价）', () => {
    const strategy = strategyOf({ strategy: 'schedule' });
    const day = ctx({ config: scheduleConfig(windows), now: new Date('2026-08-24T12:00:00+08:00') });
    expect(strategy.resolvePriceOverrides(day)).toBeNull();
    expect(strategy.settleUnitPrice(day)).toBe('0.1');
  });

  it('边界左闭右开：18:00:00 整点已入谷，07:00:00 整点已出谷（Asia/Shanghai 墙钟）', () => {
    const strategy = strategyOf({ strategy: 'schedule' });
    const at = (iso: string) => ctx({ config: scheduleConfig(windows), now: new Date(iso) });
    expect(strategy.resolvePriceOverrides(at('2026-08-24T18:00:00+08:00'))).not.toBeNull();
    expect(strategy.resolvePriceOverrides(at('2026-08-24T06:59:00+08:00'))).not.toBeNull();
    expect(strategy.resolvePriceOverrides(at('2026-08-24T07:00:00+08:00'))).toBeNull();
    expect(strategy.resolvePriceOverrides(at('2026-08-24T17:59:00+08:00'))).toBeNull();
  });

  it('跨午夜窗口按计费时区墙钟匹配（UTC 时刻换算，非服务器本地时）', () => {
    const strategy = strategyOf({ strategy: 'schedule' });
    const at = (iso: string) =>
      ctx({ config: scheduleConfig(windows), now: new Date(iso) });
    // UTC 10:00 = 上海 18:00（窗口起点）→ 命中
    expect(strategy.resolvePriceOverrides(at('2026-08-24T10:00:00Z'))).not.toBeNull();
    // UTC 15:00 = 上海 23:00（窗口内）→ 命中
    expect(strategy.resolvePriceOverrides(at('2026-08-24T15:00:00Z'))).not.toBeNull();
    // UTC 23:30 = 上海 07:30（窗口终点之后）→ 未命中
    expect(strategy.resolvePriceOverrides(at('2026-08-24T23:30:00Z'))).toBeNull();
    // UTC 09:59 = 上海 17:59（窗口起点之前）→ 未命中
    expect(strategy.resolvePriceOverrides(at('2026-08-24T09:59:00Z'))).toBeNull();
  });

  it('多档窗口（N 档）各按命中取价；estimate = 基价与全部窗口单价的最大值（保守）', () => {
    const multi = [
      { start: '00:00', end: '07:00', unitPrice: '0.005' },
      { start: '07:00', end: '18:00', unitPrice: '0.2' },
      { label: '峰时', start: '18:00', end: '00:00', unitPrice: '0.3' },
    ];
    const strategy = strategyOf({ strategy: 'schedule' });
    expect(
      strategy.resolvePriceOverrides(ctx({ config: scheduleConfig(multi) }))?.pricingWindow,
    ).toBe('00:00-07:00');
    expect(
      strategy.settleUnitPrice(ctx({ config: scheduleConfig(multi), now: new Date('2026-08-24T08:00:00+08:00') })),
    ).toBe('0.2');
    expect(strategy.estimateUnitPrice(ctx({ config: scheduleConfig(multi) }))).toBe('0.3');
  });

  it('label 兜底 "start-end"；"24:00" 结束写法 = 全天窗口收尾', () => {
    expect(windowLabelOf({ start: '18:00', end: '07:00' })).toBe('18:00-07:00');
    expect(windowLabelOf({ start: '18:00', end: '07:00', label: '  ' })).toBe('18:00-07:00');
    // "24:00" 不是合法 HH:MM（23:59 后用 00:00 表达收尾——minuteOf 返回 null 走校验拒绝）
    expect(validateScheduleWindows([{ start: '18:00', end: '24:00', unitPrice: '1' }])).toEqual({
      field: 'window.format',
      index: 0,
      value: '24:00',
    });
  });

  it('未配置 windows（空数组/缺省）：覆盖 null，settle 回落基价列', () => {
    const strategy = strategyOf({ strategy: 'schedule' });
    expect(strategy.resolvePriceOverrides(ctx({ config: { strategy: 'schedule' } }))).toBeNull();
    expect(
      strategy.resolvePriceOverrides(ctx({ config: scheduleConfig([]) })),
    ).toBeNull();
    expect(
      strategy.settleUnitPrice(ctx({ config: scheduleConfig([]) })),
    ).toBe('0.1');
  });
});

describe('validateScheduleWindows（写入校验）', () => {
  it('空表拒绝；格式非法拒绝', () => {
    expect(validateScheduleWindows([])).toEqual({ field: 'windows.empty' });
    expect(validateScheduleWindows([{ start: '8:00', end: '07:00', unitPrice: '1' }])).toEqual({
      field: 'window.format',
      index: 0,
      value: '8:00',
    });
    expect(validateScheduleWindows([{ start: '08:00', end: '7:00', unitPrice: '1' }])).toEqual({
      field: 'window.format',
      index: 0,
      value: '7:00',
    });
  });

  it('start === end（零长度）拒绝；无任何价格字段拒绝', () => {
    expect(validateScheduleWindows([{ start: '08:00', end: '08:00', unitPrice: '1' }])).toEqual({
      field: 'window.empty',
      index: 0,
    });
    expect(validateScheduleWindows([{ start: '08:00', end: '09:00', label: 'x' }])).toEqual({
      field: 'window.no_price',
      index: 0,
    });
  });

  it('重叠拒绝（普通窗口相邻可拼接；跨午夜展开后与日间窗口冲突同样拒绝）', () => {
    // 相邻拼接合法（左闭右开不重叠）
    expect(
      validateScheduleWindows([
        { start: '00:00', end: '07:00', unitPrice: '1' },
        { start: '07:00', end: '08:00', unitPrice: '1' },
      ]),
    ).toBeNull();
    // 直接重叠
    expect(
      validateScheduleWindows([
        { start: '00:00', end: '07:00', unitPrice: '1' },
        { start: '06:00', end: '08:00', unitPrice: '1' },
      ]),
    ).toEqual({ field: 'window.overlap', index: 1, other: 0 });
    // 跨午夜展开（18:00→01:00）与 00:30-00:45 冲突
    expect(
      validateScheduleWindows([
        { start: '18:00', end: '01:00', unitPrice: '1' },
        { start: '00:30', end: '00:45', unitPrice: '1' },
      ]),
    ).toEqual({ field: 'window.overlap', index: 1, other: 0 });
  });

  it('三档全天覆盖合法（0-7 / 7-18 / 18-24→0）', () => {
    expect(
      validateScheduleWindows([
        { start: '00:00', end: '07:00', unitPrice: '1' },
        { start: '07:00', end: '18:00', unitPrice: '2' },
        { start: '18:00', end: '00:00', unitPrice: '3' },
      ]),
    ).toBeNull();
  });
});

describe('minuteOfDayInZone（计费时区分钟）', () => {
  it('按 IANA 时区换算墙钟分钟；两时区同一时刻差值正确', () => {
    const now = new Date('2026-08-24T16:30:00Z'); // 上海 00:30 / UTC 16:30
    expect(minuteOfDayInZone(now, 'Asia/Shanghai')).toBe(30);
    expect(minuteOfDayInZone(now, 'UTC')).toBe(16 * 60 + 30);
    expect(minuteOfDayInZone(now, 'America/New_York')).toBe(12 * 60 + 30);
  });

  it('非法时区抛 RangeError（fail-loud——不静默错档计价）', () => {
    expect(() => minuteOfDayInZone(new Date(), 'Not/AZone')).toThrow(RangeError);
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
