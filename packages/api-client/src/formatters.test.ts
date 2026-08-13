import { describe, expect, it } from 'vitest';
import { fmtBalance, fmtCost, fmtPrice, formatMoney, formatYuan } from './formatters';

describe('formatMoney', () => {
  it('固定展示 4 位并截断多余小数', () => {
    expect(formatMoney('1.998585740000000000')).toBe('1.9985');
    expect(formatMoney('1.999999999999999999')).toBe('1.9999');
    expect(formatMoney('2')).toBe('2.0000');
  });

  it('负数向 0 截断且不产生负零', () => {
    expect(formatMoney('-1.99859')).toBe('-1.9985');
    expect(formatMoney('-0.00009')).toBe('0.0000');
  });

  it('不把高精度 DB numeric 字符串转成浮点数', () => {
    expect(formatMoney('9007199254740993.987654321')).toBe('9007199254740993.9876');
  });

  it('支持 number 的科学计数法并允许指定精度', () => {
    expect(formatMoney(1e-7)).toBe('0.0000');
    expect(formatMoney(1.23456e3, 2)).toBe('1234.56');
  });

  it('所有金额语义方法统一使用 4 位截断', () => {
    for (const format of [fmtBalance, fmtCost, fmtPrice, formatYuan]) {
      expect(format('8.76549')).toBe('8.7654');
    }
  });

  it('无效或空值按零展示', () => {
    expect(formatMoney(null)).toBe('0.0000');
    expect(formatMoney('invalid')).toBe('0.0000');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('0.0000');
  });
});
