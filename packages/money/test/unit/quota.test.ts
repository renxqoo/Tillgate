import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { deductQuota, settleAgainstHold } from '../../src/quota.js';

function expectDecimal(actual: Decimal, expected: string): void {
  expect(actual.toString()).toBe(new Decimal(expected).toString());
}

describe('deductQuota（元 + decimal）', () => {
  it('费用 ≤ 剩余额度：全扣套餐', () => {
    const r = deductQuota('0.03', '0.1');
    expectDecimal(r.planAmount, '0.03');
    expectDecimal(r.remaining, '0.07');
  });

  it('费用 > 剩余额度：扣光套餐，剩余归 0', () => {
    const r = deductQuota('0.13', '0.1');
    expectDecimal(r.planAmount, '0.1');
    expectDecimal(r.remaining, '0');
  });

  it('无额度：套餐承担 0', () => {
    const r = deductQuota('0.05', '0');
    expectDecimal(r.planAmount, '0');
    expectDecimal(r.remaining, '0');
  });
});

describe('settleAgainstHold（元 + decimal）', () => {
  it('超出 hold → 补扣差额', () => {
    const r = settleAgainstHold('0.12', '0.1');
    expectDecimal(r.deduct, '0.02');
    expectDecimal(r.refund, '0');
  });

  it('低于 hold → 退款差额', () => {
    const r = settleAgainstHold('0.08', '0.1');
    expectDecimal(r.deduct, '0');
    expectDecimal(r.refund, '0.02');
  });

  it('恰好相等 → 无补扣无退款', () => {
    const r = settleAgainstHold('0.1', '0.1');
    expectDecimal(r.deduct, '0');
    expectDecimal(r.refund, '0');
  });
});
