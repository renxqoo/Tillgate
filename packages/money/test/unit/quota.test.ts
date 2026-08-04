import { describe, expect, it } from 'vitest';
import { deductQuota, settleAgainstHold } from '../../src/quota.js';

describe('deductQuota', () => {
  it('费用 ≤ 剩余额度：全扣套餐', () => {
    expect(deductQuota(30, 100)).toEqual({ planAmount: 30, remaining: 70 });
  });

  it('费用 > 剩余额度：扣光套餐，剩余归 0', () => {
    expect(deductQuota(130, 100)).toEqual({ planAmount: 100, remaining: 0 });
  });

  it('无额度：套餐承担 0', () => {
    expect(deductQuota(50, 0)).toEqual({ planAmount: 0, remaining: 0 });
  });
});

describe('settleAgainstHold', () => {
  it('超出 hold → 补扣差额', () => {
    expect(settleAgainstHold(120, 100)).toEqual({ deduct: 20, refund: 0 });
  });

  it('低于 hold → 退款差额', () => {
    expect(settleAgainstHold(80, 100)).toEqual({ deduct: 0, refund: 20 });
  });

  it('恰好相等 → 无补扣无退款', () => {
    expect(settleAgainstHold(100, 100)).toEqual({ deduct: 0, refund: 0 });
  });
});
