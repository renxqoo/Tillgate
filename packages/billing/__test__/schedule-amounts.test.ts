/**
 * schedule 分时段计价的金额链路验收：策略解析 → 预扣押金（estimateMaxCost）→
 * 实扣账单（calcAmount）全程真实代码贯通，金额手算对照。
 *
 * 不变量（每条都可用例里的数字复述）：
 *   1. 同一准入时刻解析出的快照价，预扣与实扣同源——hold ≥ settle 恒成立；
 *   2. 窗口只覆盖写到的轴（cache 价未覆盖 → 结算用基价、押金按贵价口径）；
 *   3. 昼夜两档各自 hold/settle 自洽，互不串价。
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money.js';
import { calcAmount, estimateMaxCost } from '../src/domain/rating/pricing.js';
import { strategyOf, type BillingConfig } from '../src/domain/rating/pricing-strategy.js';
import type { PricingWindow } from '../src/domain/rating/schedule.js';

/**
 * 模型：input 2 元/M、cacheInput 2 元/M、cacheWrite 0、output 8 元/M；
 * 谷时段 18:00–07:00 覆盖 input 0.5 / output 2（cache 轴未覆盖 → 回落基价）。
 */
const TOKEN_MODEL = {
  inputPrice: '2',
  cacheInputPrice: '2',
  cacheWritePrice: null,
  outputPrice: '8',
  unitPrice: null as string | null,
  unitUpperBound: 0,
};
const NIGHT_WINDOW: PricingWindow[] = [
  { label: '谷时段', start: '18:00', end: '07:00', inputPrice: '0.5', outputPrice: '2' },
];
const scheduleConfig = (windows: PricingWindow[]): BillingConfig => ({
  strategy: 'schedule',
  params: { windows },
});

/** 准入时刻 + 计费时区 → 解析后的五价快照（gateway catalog-port 同口径） */
function resolvedAt(windows: PricingWindow[], iso: string) {
  const overrides = strategyOf({ strategy: 'schedule' }).resolvePriceOverrides({
    units: 0,
    body: {},
    config: scheduleConfig(windows),
    fallbackUnitPrice: TOKEN_MODEL.unitPrice ?? '0',
    now: new Date(iso),
    timezone: 'Asia/Shanghai',
  });
  return {
    inputPrice: overrides?.inputPrice ?? TOKEN_MODEL.inputPrice,
    cacheInputPrice: overrides?.cacheInputPrice ?? TOKEN_MODEL.cacheInputPrice,
    cacheWritePrice: overrides?.cacheWritePrice ?? TOKEN_MODEL.cacheWritePrice,
    outputPrice: overrides?.outputPrice ?? TOKEN_MODEL.outputPrice,
    unitPrice: overrides?.unitPrice ?? '0',
  };
}

describe('schedule 金额链路（token 模型 × 系数 0.8）', () => {
  const coefficient = '0.8';
  const NIGHT = '2026-08-24T23:00:00+08:00'; // 谷时（窗口内）
  const DAY = '2026-08-24T12:00:00+08:00'; // 峰时（未命中 → 基价）

  it('谷时：未缓存输入 1M + 输出 0.5M → 实扣 1.2 元；押金 2.72 元 ≥ 实扣', () => {
    const p = resolvedAt(NIGHT_WINDOW, NIGHT);
    expect(p.inputPrice).toBe('0.5');
    expect(p.outputPrice).toBe('2');
    expect(p.cacheInputPrice).toBe('2'); // 窗口未覆盖 → 基价
    // 押金：输入上界 1.2M × 贵价 max(0.5, 2, 2) + 输出上界 0.5M × 2，再 × 系数
    const hold = estimateMaxCost({
      estimatedInputTokens: 1_200_000,
      maxOutputTokens: 500_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      cacheWritePrice: p.cacheWritePrice ?? undefined,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      unitUpperBound: 0,
      coefficient,
    });
    // (1.2×2 + 0.5×2) × 0.8 = 2.72
    expect(hold.toString()).toBe('2.72');
    const settle = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 500_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      coefficient,
    });
    // (1×0.5 + 0.5×2) × 0.8 = 1.2
    expect(settle.toString()).toBe('1.2');
    expect(hold.gte(settle)).toBe(true);
  });

  it('谷时缓存命中 0.6M：cache 轴按基价 2 计 → 实扣 1.92 元（未覆盖轴不逃费）', () => {
    const p = resolvedAt(NIGHT_WINDOW, NIGHT);
    const settle = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      outputTokens: 500_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      coefficient,
    });
    // (0.4×0.5 + 0.6×2 + 0.5×2) × 0.8 = 2.4 × 0.8 = 1.92
    expect(settle.toString()).toBe('1.92');
  });

  it('峰时：同用量全按基价 → 实扣 4.8 元、押金 5.12 元（各自 hold ≥ settle，昼夜不串价）', () => {
    const p = resolvedAt(NIGHT_WINDOW, DAY);
    expect(p.inputPrice).toBe('2');
    expect(p.outputPrice).toBe('8');
    const hold = estimateMaxCost({
      estimatedInputTokens: 1_200_000,
      maxOutputTokens: 500_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      cacheWritePrice: p.cacheWritePrice ?? undefined,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      unitUpperBound: 0,
      coefficient,
    });
    // (1.2×2 + 0.5×8) × 0.8 = 6.4 × 0.8 = 5.12
    expect(hold.toString()).toBe('5.12');
    const settle = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 500_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      coefficient,
    });
    // (1×2 + 0.5×8) × 0.8 = 6 × 0.8 = 4.8
    expect(settle.toString()).toBe('4.8');
    expect(hold.gte(settle)).toBe(true);
  });
});

describe('schedule 金额链路（单位计价模型 × 系数 0.8）', () => {
  const UNIT_MODEL = {
    inputPrice: '0',
    cacheInputPrice: '0',
    cacheWritePrice: null,
    outputPrice: '0',
    unitPrice: '0.02',
  };
  const windows: PricingWindow[] = [
    { label: '夜图', start: '00:00', end: '07:00', unitPrice: '0.008' },
  ];

  function unitPriceAt(iso: string): string {
    const ctx = {
      units: 2,
      body: { n: 2 },
      config: scheduleConfig(windows),
      fallbackUnitPrice: UNIT_MODEL.unitPrice,
      now: new Date(iso),
      timezone: 'Asia/Shanghai',
    };
    const strategy = strategyOf({ strategy: 'schedule' });
    return strategy.resolvePriceOverrides(ctx)?.unitPrice ?? strategy.settleUnitPrice(ctx);
  }

  it('夜档 2 张 × 0.008 × 0.8 = 0.0128 元；昼档同量 0.032 元；押金 = 上界 × 解析单价', () => {
    const night = unitPriceAt('2026-08-24T03:00:00+08:00');
    expect(night).toBe('0.008');
    const nightHold = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      inputPrice: '0',
      outputPrice: '0',
      unitPrice: night,
      unitUpperBound: 2,
      coefficient: '0.8',
    });
    expect(nightHold.toString()).toBe('0.0128');
    const nightSettle = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 2,
      unitPrice: night,
      coefficient: '0.8',
    });
    expect(nightSettle.toString()).toBe('0.0128');
    expect(nightHold.gte(nightSettle)).toBe(true);

    const day = unitPriceAt('2026-08-24T12:00:00+08:00');
    expect(day).toBe('0.02');
    expect(
      calcAmount({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        inputPrice: '0',
        cacheInputPrice: '0',
        outputPrice: '0',
        units: 2,
        unitPrice: day,
        coefficient: '0.8',
      }).toString(),
    ).toBe('0.032');
  });
});

describe('schedule 免费零价防护（沿用既有结构性拒绝）', () => {
  it('窗口只清 input/output → cache 轴回落基价兜底，押金 2 元不免费（漏覆盖不产生免费窗口）', () => {
    const p = resolvedAt(
      [{ start: '18:00', end: '07:00', inputPrice: '0', outputPrice: '0' }],
      '2026-08-24T23:00:00+08:00',
    );
    const hold = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      cacheWritePrice: p.cacheWritePrice ?? undefined,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      unitUpperBound: 0,
      coefficient: '1',
    });
    // 贵价口径 max(0, cache 基价 2, 0) = 2 → 1M×2/1M = 2：cache 轴未覆盖即兜底计价
    expect(hold.toString()).toBe('2');
  });

  it('五轴全零窗口 → 预扣 0 → 授权侧对「零价但未声明免费」结构性拒绝（免费额度印刷机防线不变）', () => {
    const p = resolvedAt(
      [
        {
          start: '18:00',
          end: '07:00',
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
        },
      ],
      '2026-08-24T23:00:00+08:00',
    );
    const hold = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000,
      inputPrice: p.inputPrice,
      cacheInputPrice: p.cacheInputPrice,
      cacheWritePrice: p.cacheWritePrice ?? undefined,
      outputPrice: p.outputPrice,
      unitPrice: '0',
      unitUpperBound: 0,
      coefficient: '1',
    });
    // 全零 → 押 0：calculateRequired 对「零价但未声明免费」结构性拒绝（既有防线）
    expect(hold.toString()).toBe('0');
  });
});

// Decimal 精度健全性：所有对照值均以 Decimal 全精度字符串断言（无浮点误差通道）
describe('Decimal 精度健全', () => {
  it('2.72 / 1.2 / 4.8 / 5.12 / 1.92 / 0.0128 均可精确表示', () => {
    for (const v of ['2.72', '1.2', '4.8', '5.12', '1.92', '0.0128']) {
      expect(new Decimal(v).toString()).toBe(v);
    }
  });
});
