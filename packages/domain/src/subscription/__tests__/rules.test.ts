/** 订阅生命周期纯规则：窗口顺延 / 线性折旧 / 升档资格 / 席位能力。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../wallet/money.js';
import {
  assertChangeEligibility,
  assertSeatsAllowed,
  assertValidQuantity,
  changeDiff,
  periodEnd,
  remainingQuota,
  remainingValue,
  renewalStart,
} from '../rules.js';
import { SubscriptionDomainError } from '../errors.js';

const day = (n: number) => new Date('2026-01-01T00:00:00Z').getTime() + n * 86_400_000;

describe('窗口', () => {
  it('renewalStart：未到期从旧 end 顺延；到期从 now 起', () => {
    const now = new Date(day(10));
    const futureEnd = new Date(day(20));
    const pastEnd = new Date(day(5));
    expect(renewalStart(futureEnd, now).getTime()).toBe(day(20));
    expect(renewalStart(pastEnd, now).getTime()).toBe(day(10));
  });

  it('periodEnd：start + periodDays 天', () => {
    expect(periodEnd(new Date(day(0)), 30).getTime()).toBe(day(30));
  });
});

describe('折算', () => {
  const snapshot = { quotaAmount: '100', usedAmount: '30', reservedAmount: '20', price: '50' };

  it('剩余额度 = 总 − 已用 − 在途', () => {
    expect(remainingQuota(snapshot).toString()).toBe('50');
  });

  it('剩余价值 = 总价 × 剩余/总额（线性折旧）', () => {
    expect(remainingValue(snapshot).toString()).toBe('25'); // 50 × 50/100
  });

  it('总额度 ≤ 0 → 剩余价值 0（除零防御）', () => {
    expect(remainingValue({ ...snapshot, quotaAmount: '0' }).eq(new Decimal(0))).toBe(true);
  });

  it('补差价 = max(0, 新总价 − 剩余价值)', () => {
    expect(changeDiff('80', '25').toString()).toBe('55');
    expect(changeDiff('20', '25').eq(new Decimal(0))).toBe(true); // 免费升级
  });
});

describe('资格与席位', () => {
  it('只升不降 + 至少一项变化', () => {
    expect(() =>
      assertChangeEligibility({ currentSortOrder: 1, targetSortOrder: 2, currentQuantity: 1, targetQuantity: 1 }),
    ).not.toThrow();
    expect(() =>
      assertChangeEligibility({ currentSortOrder: 2, targetSortOrder: 1, currentQuantity: 1, targetQuantity: 1 }),
    ).toThrowError(SubscriptionDomainError);
    expect(() =>
      assertChangeEligibility({ currentSortOrder: 1, targetSortOrder: 1, currentQuantity: 2, targetQuantity: 1 }),
    ).toThrowError(SubscriptionDomainError);
    // 无变化 = already_subscribed
    const err = (() => {
      try {
        assertChangeEligibility({ currentSortOrder: 1, targetSortOrder: 1, currentQuantity: 1, targetQuantity: 1 });
      } catch (e) {
        return e as SubscriptionDomainError;
      }
      return null;
    })();
    expect(err?.code).toBe('already_subscribed');
  });

  it('席位能力：qty>1 须 allowSeats；allowSeats 须企业（即使 qty=1）', () => {
    expect(() => assertSeatsAllowed({ quantity: 2, allowSeats: false, isEnterprise: true })).toThrowError(SubscriptionDomainError);
    expect(() => assertSeatsAllowed({ quantity: 1, allowSeats: true, isEnterprise: false })).toThrowError(SubscriptionDomainError);
    expect(() => assertSeatsAllowed({ quantity: 5, allowSeats: true, isEnterprise: true })).not.toThrow();
    expect(() => assertSeatsAllowed({ quantity: 1, allowSeats: false, isEnterprise: false })).not.toThrow();
  });

  it('数量闸：非正整数拒绝', () => {
    expect(() => assertValidQuantity(0)).toThrowError(SubscriptionDomainError);
    expect(() => assertValidQuantity(1.5)).toThrowError(SubscriptionDomainError);
    expect(() => assertValidQuantity(1)).not.toThrow();
  });
});
