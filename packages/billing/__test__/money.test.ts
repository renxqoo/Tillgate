/**
 * money 值对象行为规格（目录码断言;覆盖 Decimal 实例入参与垃圾串归类）。
 */
import { describe, expect, it } from 'vitest';
import type { BusinessError } from '@tillgate/errors';
import { isBusinessError } from '@tillgate/errors';
import {
  Decimal,
  isValidAmountString,
  normalizeAmount,
  parseNonNegativeAmount,
  parsePositiveAmount,
  toStorage,
} from '../src/domain/money.js';

/** 断言拒绝并核对目录码与 reason 上下文（旧版只断言抛出，此处锁死分类） */
function expectRejection(
  parse: (raw: string | number) => unknown,
  raw: string | number,
  reason: string,
): void {
  let caught: unknown;
  try {
    parse(raw);
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection for ${String(raw)}`);
  const err = caught as BusinessError;
  expect(err.code).toBe('billing.invalid_amount');
  expect(err.category).toBe('invalid_input');
  expect(err.context?.reason).toBe(reason);
  expect(err.context?.raw).toBe(String(raw));
}

describe('parsePositiveAmount（资金动词入参的唯一入口）', () => {
  it('合法正金额全精度保留（不 round）', () => {
    expect(parsePositiveAmount('0.1').toString()).toBe('0.1');
    expect(parsePositiveAmount('1234567890.123456789012345678').toString()).toBe(
      '1234567890.123456789012345678',
    );
  });

  it('Decimal 实例入参直接采信（同一构造器家族）', () => {
    expect(parsePositiveAmount(new Decimal('5.5')).toString()).toBe('5.5');
    expect(parsePositiveAmount(parsePositiveAmount('0.1')).toString()).toBe('0.1');
  });

  it('零/负数拒绝（non_positive）', () => {
    expectRejection(parsePositiveAmount, '0', 'non_positive');
    expectRejection(parsePositiveAmount, '-0.01', 'non_positive');
  });

  it('NaN / Infinity / 非数值拒绝（malformed）——垃圾串构造异常归类，不逃逸出分类', () => {
    expectRejection(parsePositiveAmount, 'NaN', 'malformed');
    expectRejection(parsePositiveAmount, 'Infinity', 'malformed');
    expectRejection(parsePositiveAmount, 'abc', 'malformed');
    expectRejection(parsePositiveAmount, Number.NaN, 'malformed');
    expectRejection(parsePositiveAmount, Number.POSITIVE_INFINITY, 'malformed');
  });

  it('科学计数法规范化后落库形态非法 → 拒绝（PG numeric 不收 1e-20）', () => {
    // decimal 边界（实测）：1e-19 仍是十进制形态但 19 位小数超尺度；1e-20 直接科学计数法
    expectRejection(parsePositiveAmount, '0.0000000000000000001', 'out_of_scale');
    expectRejection(parsePositiveAmount, '0.00000000000000000001', 'out_of_scale');
    expectRejection(parsePositiveAmount, '1e-30', 'out_of_scale');
    // 18 位小数是落库极限
    expect(parsePositiveAmount('0.123456789012345678').toString()).toBe('0.123456789012345678');
  });

  it('超尺度（>18 位小数 / >20 位整数）拒绝', () => {
    expectRejection(parsePositiveAmount, '0.1234567890123456789', 'out_of_scale');
    expectRejection(parsePositiveAmount, '100000000000000000000', 'out_of_scale');
  });
});

describe('parseNonNegativeAmount（授信地板允许 0）', () => {
  it('0 合法、负数拒绝', () => {
    expect(parseNonNegativeAmount('0').isZero()).toBe(true);
    expectRejection(parseNonNegativeAmount, '-1', 'non_positive');
  });

  it('垃圾串与超尺度与正金额口径同分类（两条拒绝路径独立可回归）', () => {
    expectRejection(parseNonNegativeAmount, 'abc', 'malformed');
    expectRejection(parseNonNegativeAmount, '0.1234567890123456789', 'out_of_scale');
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

  it('normalizeAmount 垃圾串归类 invalid_amount（防线对称——构造异常不逃逸）', () => {
    for (const garbage of ['not-a-number', '12abc', '', '1.2.3']) {
      try {
        normalizeAmount(garbage);
        throw new Error(`expected invalid_amount for ${garbage}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('billing.invalid_amount');
      }
    }
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
