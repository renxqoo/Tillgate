import { describe, expect, it } from 'vitest';

import { createMoneyFormatter } from '../../src/formatting/money';

describe('createMoneyFormatter', () => {
  const usd = createMoneyFormatter({ locale: 'en-US', currency: 'USD' });

  it('format: 主单位金额按 locale/币种格式化', () => {
    expect(usd.format(1234.5)).toBe('$1,234.50');
    expect(usd.format(0)).toBe('$0.00');
  });

  it('format: 负数符号', () => {
    expect(usd.format(-1234.5)).toBe('-$1,234.50');
  });

  it('formatMinor: bigint/number 最小单位转主单位', () => {
    expect(usd.formatMinor(123450n)).toBe('$1,234.50');
    expect(usd.formatMinor(123450)).toBe('$1,234.50');
    expect(usd.formatMinor(1n)).toBe('$0.01');
    expect(usd.formatMinor(-5n)).toBe('-$0.05');
  });

  it('formatMinor: 零位小数币种(JPY)不做小数放大', () => {
    const jpy = createMoneyFormatter({ locale: 'ja-JP', currency: 'JPY' });
    // JPY 符号随 ICU 平台而异(macOS JSC=U+00A5 ¥,Linux JSC/node ICU=U+FFE5 ￥)——
    // 本断言的契约是「零位小数币种不放大 + 千分位分组」,符号两种都收
    expect(jpy.formatMinor(123456n)).toMatch(/^[¥￥]123,456$/);
  });

  it('currencyDisplay=code 输出币种代码(Intl 用不换行空格分隔)', () => {
    const code = createMoneyFormatter({
      locale: 'en-US',
      currency: 'USD',
      currencyDisplay: 'code',
    });
    expect(code.format(1)).toMatch(/^USD[\u00A0 ]1\.00$/);
  });

  it('非法币种代码抛 Intl RangeError', () => {
    expect(() => createMoneyFormatter({ locale: 'en-US', currency: 'NOPE' })).toThrow(RangeError);
  });

  it('format: 非有限数抛错', () => {
    expect(() => usd.format(Number.NaN)).toThrow(/finite/);
    expect(() => usd.format(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('formatMinor: 非整数最小单位抛错', () => {
    expect(() => usd.formatMinor(1.5)).toThrow(/integer/);
  });

  it('formatMinor: 超出精确展示范围抛错(不给错误金额)', () => {
    expect(() => usd.formatMinor(10n ** 15n)).toThrow(/exact display range/);
    expect(() => usd.formatMinor(-(10n ** 15n))).toThrow(/exact display range/);
    expect(() => usd.formatMinor(2n ** 53n)).toThrow(/exact display range/);
  });

  it('精确边界内的极值仍分毫不差', () => {
    expect(usd.formatMinor(999999999999999n)).toBe('$9,999,999,999,999.99');
    expect(usd.formatMinor(-999999999999999n)).toBe('-$9,999,999,999,999.99');
  });

  it('toneOf: 正/负/零三态(含 -0)', () => {
    expect(usd.toneOf(0.01)).toBe('positive');
    expect(usd.toneOf(-0.01)).toBe('negative');
    expect(usd.toneOf(0)).toBe('zero');
    expect(usd.toneOf(-0)).toBe('zero');
    expect(() => usd.toneOf(Number.NaN)).toThrow(/finite/);
  });
});
