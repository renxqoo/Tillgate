import { describe, expect, it } from 'vitest';

import { createNumberFormatter } from '../../src/formatting/number';

describe('createNumberFormatter', () => {
  it('format: 千分位与位数截断', () => {
    const en = createNumberFormatter({
      locale: 'en-US',
      maximumFractionDigits: 2,
    });
    expect(en.format(1234.5678)).toBe('1,234.57');
    expect(en.format(-1234.5)).toBe('-1,234.5');
  });

  it('format: locale 差异(de-DE 小数逗号)', () => {
    const de = createNumberFormatter({
      locale: 'de-DE',
      maximumFractionDigits: 2,
    });
    expect(de.format(1234.5678)).toBe('1.234,57');
  });

  it('formatCompact: 短格式缩写', () => {
    const en = createNumberFormatter({ locale: 'en-US' });
    expect(en.formatCompact(1_500_000)).toBe('1.5M');
    expect(en.formatCompact(1234)).toBe('1.2K');
    expect(en.formatCompact(-91_250_000)).toBe('-91M');
    expect(en.formatCompact(0)).toBe('0');
  });

  it('formatPercent: 比例值转百分数', () => {
    const en = createNumberFormatter({ locale: 'en-US' });
    expect(en.formatPercent(0.1234, { maximumFractionDigits: 1 })).toBe('12.3%');
    expect(en.formatPercent(1)).toBe('100%');
    expect(en.formatPercent(-0.05)).toBe('-5%');
  });

  it('非有限数统一抛错', () => {
    const en = createNumberFormatter({ locale: 'en-US' });
    expect(() => en.format(Number.NaN)).toThrow(/finite/);
    expect(() => en.formatCompact(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => en.formatPercent(Number.NaN)).toThrow(/finite/);
  });
});
