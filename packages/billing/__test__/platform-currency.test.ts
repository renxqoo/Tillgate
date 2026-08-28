/**
 * 平台币种 KV 值域解析：合法 ISO 形态通过 / 小写/数字/长度错/垃圾 → null（回落缺省）。
 */
import { describe, expect, it } from 'vitest';
import { parsePlatformCurrencySetting } from '../src/application/billing/platform-currency';

describe('parsePlatformCurrencySetting', () => {
  it('合法 3 位大写通过（表驱动）', () => {
    for (const currency of ['CNY', 'USD', 'EUR', 'JPY']) {
      expect(parsePlatformCurrencySetting({ currency })).toBe(currency);
    }
  });

  it('非法形态 → null（表驱动）', () => {
    for (const raw of [
      { currency: 'cny' },
      { currency: 'CN' },
      { currency: 'CNY1' },
      { currency: '人民币' },
      { currency: '' },
      { currency: 42 },
      {},
      null,
      'CNY',
    ]) {
      expect(parsePlatformCurrencySetting(raw)).toBeNull();
    }
  });
});
