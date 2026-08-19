/** money 值对象攻击面：负数/NaN/Infinity/科学计数法/超尺度结构性拒绝。 */
import { describe, expect, it } from 'vitest';
import {
  Decimal,
  InvalidAmountError,
  isValidAmountString,
  normalizeAmount,
  parseNonNegativeAmount,
  parsePositiveAmount,
  toStorage,
} from '../money.js';

describe('parsePositiveAmount（资金动词入参的唯一入口）', () => {
  it('合法正金额全精度保留（不 round）', () => {
    expect(parsePositiveAmount('0.1').toString()).toBe('0.1');
    expect(parsePositiveAmount('1234567890.123456789012345678').toString()).toBe(
      '1234567890.123456789012345678',
    );
  });

  it('零/负数拒绝', () => {
    expect(() => parsePositiveAmount('0')).toThrow(InvalidAmountError);
    expect(() => parsePositiveAmount('-0.01')).toThrow(InvalidAmountError);
  });

  it('NaN / Infinity / 非数值拒绝', () => {
    expect(() => parsePositiveAmount('NaN')).toThrow(InvalidAmountError);
    expect(() => parsePositiveAmount('Infinity')).toThrow(InvalidAmountError);
    expect(() => parsePositiveAmount('abc')).toThrow();
  });

  it('科学计数法规范化后落库形态非法 → 拒绝（PG numeric 不收 1e-20）', () => {
    // decimal 边界（实测）：1e-19 仍是十进制形态但 19 位小数超尺度；1e-20 直接科学计数法
    expect(() => parsePositiveAmount('0.0000000000000000001')).toThrow(InvalidAmountError);
    expect(() => parsePositiveAmount('0.00000000000000000001')).toThrow(InvalidAmountError);
    expect(() => parsePositiveAmount('1e-30')).toThrow(InvalidAmountError);
    // 18 位小数是落库极限
    expect(parsePositiveAmount('0.123456789012345678').toString()).toBe('0.123456789012345678');
  });

  it('超尺度（>18 位小数）拒绝', () => {
    expect(() => parsePositiveAmount('0.1234567890123456789')).toThrow(InvalidAmountError);
  });
});

describe('parseNonNegativeAmount（授信地板允许 0）', () => {
  it('0 合法、负数拒绝', () => {
    expect(parseNonNegativeAmount('0').isZero()).toBe(true);
    expect(() => parseNonNegativeAmount('-1')).toThrow(InvalidAmountError);
  });
});

describe('存储形态', () => {
  it('isValidAmountString：合法形态判定', () => {
    expect(isValidAmountString('0')).toBe(true);
    expect(isValidAmountString('12.34')).toBe(true);
    expect(isValidAmountString('1e-5')).toBe(false);
    expect(isValidAmountString('-1')).toBe(false);
    expect(isValidAmountString('0.1234567890123456789')).toBe(false);
    expect(isValidAmountString('')).toBe(false);
  });

  it('normalizeAmount 幂等且去尾零', () => {
    expect(normalizeAmount('1.500')).toBe('1.5');
    expect(normalizeAmount(normalizeAmount('1.500'))).toBe('1.5');
    expect(normalizeAmount('007')).toBe('7');
  });

  it('Decimal precision 40：全尺度加减不丢位', () => {
    const a = new Decimal('99999999999999999999.999999999999999999');
    const b = new Decimal('0.000000000000000001');
    expect(a.plus(b).toString()).toBe('100000000000000000000');
  });

  it('toStorage 的科学计数法边界（isValidAmountString 是落库前防线）', () => {
    expect(toStorage(new Decimal('0.0000000000000000001'))).toBe('0.0000000000000000001');
    expect(toStorage(new Decimal('0.00000000000000000001'))).toBe('1e-20');
  });
});
