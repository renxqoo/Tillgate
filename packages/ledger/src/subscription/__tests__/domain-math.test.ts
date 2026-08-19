/** subscription 纯函数特征规格：窗口顺延 / 线性折旧 / 变更资格（S3 抽取，公式单一真相）。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/wallet/metering';
import { renewalStart, periodEnd } from '../period.js';
import { remainingQuota, remainingValue, changeDiff } from '../proration.js';
import { assertChangeEligibility, assertSeatsAllowed } from '../eligibility.js';
import { LedgerError } from '../../platform/errors.js';

describe('period：订阅窗口顺延', () => {
  it('未到期续费从旧 end 起（顺延），到期后续费从 now 起', () => {
    const now = new Date('2026-08-18T10:00:00Z');
    const future = new Date('2026-09-01T00:00:00Z');
    const past = new Date('2026-08-01T00:00:00Z');
    expect(renewalStart(future, now).getTime()).toBe(future.getTime());
    expect(renewalStart(past, now).getTime()).toBe(now.getTime());
  });

  it('周期末点 = start + periodDays 天', () => {
    const start = new Date('2026-08-18T10:00:00Z');
    expect(periodEnd(start, 30).toISOString()).toBe('2026-09-17T10:00:00.000Z');
  });
});

describe('proration：线性折旧', () => {
  const snapshot = { quotaAmount: '100', usedAmount: '25', reservedAmount: '15', price: '60' };

  it('剩余额度 = 总额度 − 已用 − 在途', () => {
    expect(remainingQuota(snapshot).toString()).toBe('60');
  });

  it('剩余价值 = 总价 × 剩余额度/总额度', () => {
    // 60 × 60/100 = 36
    expect(remainingValue(snapshot).toString()).toBe('36');
  });

  it('总额度 ≤ 0 → 剩余价值 0（脏数据不得放大）', () => {
    expect(remainingValue({ ...snapshot, quotaAmount: '0' }).toString()).toBe('0');
    expect(remainingValue({ ...snapshot, quotaAmount: '-5' }).toString()).toBe('0');
  });

  it('补差价 = max(0, 新总价 − 剩余价值)', () => {
    expect(changeDiff('100', '36').toString()).toBe('64');
    expect(changeDiff('30', '36').toString()).toBe('0');
    expect(changeDiff('30', new Decimal('36')).toString()).toBe('0');
  });
});

describe('eligibility：只升不降 + 席位门槛', () => {
  const base = { currentSortOrder: 1, targetSortOrder: 2, currentQuantity: 1, targetQuantity: 2 };

  it('层级或席位任一提升即可', () => {
    expect(() => assertChangeEligibility(base)).not.toThrow();
    expect(() =>
      assertChangeEligibility({ ...base, targetQuantity: 1 }),
    ).not.toThrow();
  });

  it('层级下降 / 席位缩容 → downgrade_not_allowed', () => {
    expect(() => assertChangeEligibility({ ...base, targetSortOrder: 0 })).toThrow(
      new LedgerError('downgrade_not_allowed'),
    );
    expect(() =>
      assertChangeEligibility({
        currentSortOrder: 1,
        targetSortOrder: 2,
        currentQuantity: 3,
        targetQuantity: 2,
      }),
    ).toThrow(LedgerError);
  });

  it('无变化 → already_subscribed', () => {
    expect(() =>
      assertChangeEligibility({ ...base, targetSortOrder: 1, targetQuantity: 1 }),
    ).toThrow(LedgerError);
  });

  it('席位能力：qty>1 需 allowSeats；allowSeats 套餐需企业账户', () => {
    expect(() =>
      assertSeatsAllowed({ quantity: 2, allowSeats: false, isEnterprise: true }),
    ).toThrow(LedgerError);
    expect(() =>
      assertSeatsAllowed({ quantity: 1, allowSeats: true, isEnterprise: false }),
    ).toThrow(LedgerError);
    expect(() =>
      assertSeatsAllowed({ quantity: 3, allowSeats: true, isEnterprise: true }),
    ).not.toThrow();
  });
});
