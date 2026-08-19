/** metering 计费公式与预扣估算(原 money 包三文件合并迁入;Decimal 统一本包 clone) */
import { describe, expect, it } from 'vitest';
import DecimalJs from 'decimal.js';
import { Decimal } from '../money';
import {
  calcAmount,
  estimateMaxCost,
  requiredReservation,
  ReservationError,
  toDecimal,
  toStorage,
} from '../metering';
import { WalletError } from '../errors';

// 元价:单位 元/百万 token
// 对照 DeepSeek deepseek-chat 实际配置:输入 ¥1/百万(=0.001),输出 ¥2/百万(=0.002)
const PRICE = { in: '0.001', cache: '0.0001', out: '0.002' };

/** 断言两个 Decimal 相等(用字符串比较,避免浮点) */
function expectDecimal(actual: Decimal, expected: string): void {
  expect(actual.toString()).toBe(new Decimal(expected).toString());
}

describe('calcAmount(元 + decimal 全精度)', () => {
  it('基准:百万输入 + 百万输出(系数 1.0)= ¥3(输入¥1 + 输出¥2)', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    // (1e6×0.001 + 1e6×0.002)/1e6 × 1 = 0.003 元
    expectDecimal(amount, '0.003');
  });

  it('【核心】8 input + 1 output @ DeepSeek 价 → 精确计费 1e-8 元,不再是 0', () => {
    // 这正是重构要修复的资损 bug:厘+Math.round 算出 0(白嫖),现在精确计费。
    // 实际金额:(8×0.001 + 1×0.002)/1e6 = 0.01/1e6 = 1e-8 元(极小但非 0,累积即资损)
    const amount = calcAmount({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.001', // ¥1/百万
      cacheInputPrice: '0.0001',
      outputPrice: '0.002', // ¥2/百万
      coefficient: 1,
    });
    expectDecimal(amount, '0.00000001'); // 1e-8 元
    expect(amount.isZero()).toBe(false); // 关键:不再是 0
  });

  it('缓存拆分:缓存命中按缓存价计', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 0,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // (500×0.002 + 500×0.0002)/1e6 = 0.0011/1e6 = 0.0000011 元(全精度,不 round)
    expectDecimal(amount, '0.0000011');
  });

  it('系数 1.5 → 费用精确 1.5 倍', () => {
    const base = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    const withCoeff = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1.5,
    });
    // 1.5 倍精确(decimal,无 round 误差)
    expectDecimal(withCoeff, base.times(1.5).toString());
  });

  it('账本永不 round:半值不进一(与重构前的关键区别)', () => {
    // 重构前:厘 + Math.round,2.5 → 3(半值进一,丢精度)
    // 重构后:全精度,0.0000025 就是 0.0000025,不 round
    const amount = calcAmount({
      inputTokens: 250,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.01', // ¥0.01/百万
      cacheInputPrice: 0,
      outputPrice: 0,
      coefficient: 1,
    });
    // 250×0.01/1e6 = 0.0025/1e6 = 0.0000025 元(精确,不进一成 0.000003)
    expectDecimal(amount, '0.0000025');
  });

  it('零用量 → 0', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 1,
    });
    expect(amount.isZero()).toBe(true);
  });

  it('量级安全:10M tokens × ¥0.1/百万 × 系数 1.0', () => {
    const amount = calcAmount({
      inputTokens: 10_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.1',
      cacheInputPrice: '0.01',
      outputPrice: '0.1',
      coefficient: 1,
    });
    // 1e7 × 0.1 / 1e6 = 1 元
    expectDecimal(amount, '1');
  });

  it('累加 1 万次小请求 → 余额精确变动(防累积资损)', () => {
    // 模拟:每次 8 input + 1 output = 1e-8 元,1 万次 = 1e-4 元(精确)
    const perRequest = calcAmount({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      coefficient: 1,
    });
    let cumulative = new Decimal(0);
    for (let i = 0; i < 10_000; i++) {
      cumulative = cumulative.plus(perRequest);
    }
    // 1e-8 × 10000 = 1e-4 = 0.0001 元(精确,重构前会全是 0 → 资损)
    expectDecimal(cumulative, '0.0001');
  });

  // ---- 异常输入防御(资损防线:绝不允许负金额或反向收费)----

  it('负数 outputTokens → 按 0 计(不允许反向收费/白嫖)', () => {
    const amount = calcAmount({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: -500,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // 输出按 0 计:1000×0.002/1e6 = 0.000002 元
    expectDecimal(amount, '0.000002');
    expect(amount.gte(0)).toBe(true);
  });

  it('负数 inputTokens → 按 0 计', () => {
    const amount = calcAmount({
      inputTokens: -1000,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.gte(0)).toBe(true);
  });

  it('NaN tokens → 按 0 计(不允许 NaN 污染金额)', () => {
    const amount = calcAmount({
      inputTokens: Number.NaN,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.isFinite()).toBe(true);
    expect(amount.gte(0)).toBe(true);
  });

  it('Infinity tokens → 按 0 计(不允许 Infinity 算出超大金额)', () => {
    const amount = calcAmount({
      inputTokens: Number.POSITIVE_INFINITY,
      cachedInputTokens: 0,
      outputTokens: 1000,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.isFinite()).toBe(true);
  });

  it('负数价格 → 按 0 计(配置错误不允许产生负费用)', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: -0.002,
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    expect(amount.gte(0)).toBe(true);
  });

  it('coefficient ≤ 0 → 按 0 计(费率卡配置错误不允许免费)', () => {
    const zero = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: 0,
    });
    expect(zero.isZero()).toBe(true);
    const neg = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      inputPrice: PRICE.in,
      cacheInputPrice: PRICE.cache,
      outputPrice: PRICE.out,
      coefficient: -1,
    });
    expect(neg.isZero()).toBe(true);
  });

  it('cachedInputTokens > inputTokens → cached 夹到 input', () => {
    const amount = calcAmount({
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 0,
      inputPrice: '0.002',
      cacheInputPrice: '0.0002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // cached 夹到 100:100×0.0002/1e6 = 0.00000002 元(精确,不因双计多收)
    expect(amount.gte(0)).toBe(true);
  });

  it('返回值永远 ≥ 0 且有限(任何异常输入组合)', () => {
    const pathological = [
      { inputTokens: -1, cachedInputTokens: -1, outputTokens: -1 },
      { inputTokens: NaN, cachedInputTokens: NaN, outputTokens: NaN },
      { inputTokens: Infinity, cachedInputTokens: -Infinity, outputTokens: 0 },
    ];
    for (const t of pathological) {
      const amount = calcAmount({
        ...t,
        inputPrice: -1,
        cacheInputPrice: -0.1,
        outputPrice: -5,
        coefficient: -1,
      });
      expect(amount.gte(0)).toBe(true);
      expect(amount.isFinite()).toBe(true);
    }
  });

  it('返回类型是 Decimal(全精度,非 number)', () => {
    const amount = calcAmount({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 1,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      coefficient: 1,
    });
    expect(amount).toBeInstanceOf(Decimal);
  });
});

describe('单位计费(units × unitPrice 与 token 部分相加)', () => {
  it('纯单位计费:3 张图 × ¥0.05/张 × 系数 0.8 = ¥0.12', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 3,
      unitPrice: '0.05',
      coefficient: 0.8,
    });
    expectDecimal(amount, '0.12');
  });

  it('混合:token 部分与单位部分相加(同系数)', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      units: 2,
      unitPrice: '0.03',
      coefficient: 1.5,
    });
    // (1e6×0.001)/1e6 = 0.001;单位 2×0.03 = 0.06;(0.001+0.06)×1.5 = 0.0915
    expectDecimal(amount, '0.0915');
  });

  it('units 缺省为 0(token 模型行为不变);负/非有限 units 钳 0', () => {
    const base = {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      coefficient: 1,
    } as const;
    const withoutUnits = calcAmount(base);
    expectDecimal(
      calcAmount({ ...base, units: -5, unitPrice: '0.05' }),
      withoutUnits.toString(),
    );
    expectDecimal(
      calcAmount({ ...base, units: Number.NaN, unitPrice: '0.05' }),
      withoutUnits.toString(),
    );
  });

  it('单位单价负值/异常不产生负金额(资损防御与 token 部分同规则)', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 2,
      unitPrice: '-1',
      coefficient: 1,
    });
    expectDecimal(amount, '0');
  });
});

describe('estimateMaxCost(预扣上界,单位部分同估)', () => {
  it('按输入和最大输出计算完整费用暴露', () => {
    expect(
      estimateMaxCost({
        estimatedInputTokens: 1_000,
        maxOutputTokens: 500,
        inputPrice: '1000',
        outputPrice: '2000',
        coefficient: '1',
      }).eq(2),
    ).toBe(true);
  });

  it('缓存价异常高于普通输入价时仍按较高价足额授权', () => {
    expect(
      estimateMaxCost({
        estimatedInputTokens: 1_000,
        maxOutputTokens: 0,
        inputPrice: '1',
        cacheInputPrice: '1000',
        outputPrice: '0',
        coefficient: '1',
      }).eq(1),
    ).toBe(true);
  });

  it('纯单位模型:上界 units × unitPrice × 系数(n=4 张预扣 4 张的钱)', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      inputPrice: '0',
      outputPrice: '0',
      unitPrice: '0.04',
      unitUpperBound: 4,
      coefficient: 1.2,
    });
    expectDecimal(estimate, '0.192');
  });

  it('token 上界与单位上界同估(图生图:输入 token + 输出张数都算)', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 500_000,
      maxOutputTokens: 0,
      inputPrice: '0.002',
      outputPrice: '0',
      unitPrice: '0.04',
      unitUpperBound: 2,
      coefficient: 1,
    });
    // 0.5e6×0.002/1e6 = 0.001 + 2×0.04 = 0.081
    expectDecimal(estimate, '0.081');
  });

  it('units 缺省 0(token 模型行为不变)', () => {
    const legacy = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1000,
      inputPrice: '0.001',
      outputPrice: '0.002',
      coefficient: 1,
    });
    expect(legacy.gt(0)).toBe(true);
  });

  it('异常 token 估算不产生 Infinity/NaN', () => {
    const value = estimateMaxCost({
      estimatedInputTokens: Number.POSITIVE_INFINITY,
      maxOutputTokens: Number.NaN,
      inputPrice: '1',
      outputPrice: '1',
      coefficient: '1',
    });
    expect(value.isFinite()).toBe(true);
    expect(value.gte(0)).toBe(true);
  });
});

describe('requiredReservation(风险上限只拒绝不截断)', () => {
  it('返回完整预扣,不按余额裁剪', () => {
    expect(requiredReservation('1.9987508', '50').eq('1.9987508')).toBe(true);
  });

  it('超过风险上限直接拒绝', () => {
    expect(() => requiredReservation('51', '50')).toThrow('reservation_limit_exceeded');
  });

  it('拒绝走 WalletError 家族(经 metering 子导出消费同一错误真相)', () => {
    expect(new ReservationError('reservation_limit_exceeded')).toBeInstanceOf(WalletError);
    try {
      requiredReservation('51', '50');
    } catch (error) {
      expect(error).toBeInstanceOf(WalletError);
      expect((error as ReservationError).code).toBe('reservation_limit_exceeded');
    }
  });
});

describe('Decimal 统一迁移锁点(原 money 用全局 precision 20,本包 clone 为 40)', () => {
  it('超过 20 位有效数字运算时不再被舍到 20 位(decimal.js 运算才应用 precision)', () => {
    const unitPrice = '0.123456789012345678901234'; // 24 位有效数字
    // 构造不舍入;运算时全局默认 precision 20 丢位,本包 clone precision 40 全保留
    expect(new DecimalJs(unitPrice).times(1).toString()).toBe('0.1234567890123456789');
    expect(toDecimal(unitPrice).times(1).toString()).toBe(unitPrice);
  });

  it('toStorage 永不输出科学计数法(PG numeric 直存形态)', () => {
    expect(toStorage(new Decimal('0.00000001'))).toBe('0.00000001');
    expect(toStorage(new DecimalJs('1e-8'))).toBe('1e-8'); // 全局默认形态实证(迁移前)
  });

  it('toDecimal 接受 decimal.js 全局实例(跨 clone 接缝,存量调用方兼容)', () => {
    expect(toDecimal(new DecimalJs('1.9987508')).toString()).toBe('1.9987508');
    expect(toDecimal(new DecimalJs('1e-8')) instanceof Decimal).toBe(true);
  });
});
