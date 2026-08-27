/**
 * 出账口径守卫行为规格（错误断言按目录码判定）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { Decimal } from '../src/domain/money.js';
import {
  assertCanDebit,
  assertCreditLimitCoversExposure,
  availableToSpend,
} from '../src/domain/wallet/exposure.js';

const account = {
  kind: 'user',
  currency: 'CNY',
  balance: '10',
  creditLimit: '5',
  inFlight: '3',
} as const;

/** 断言业务拒绝并核对目录码 */
function expectBusinessCode(fn: () => void, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection (${code})`);
  expect((caught as { code: string }).code).toBe(code);
}

describe('敞口守卫（同一口径）', () => {
  it('信用口径：余额 + 授信 − 在途', () => {
    expect(availableToSpend(account).toString()).toBe('12');
  });

  it('现金口径：授信不参与', () => {
    expect(availableToSpend(account, { allowCredit: false }).toString()).toBe('7');
  });

  it('内部科目无授信概念（授信恒 0）', () => {
    expect(availableToSpend({ ...account, kind: 'internal' }).toString()).toBe('7');
  });

  it('不足时按口径分流错误码（insufficient_balance / insufficient_cash，context 携带口径事实）', () => {
    let caught: unknown;
    try {
      assertCanDebit(account, new Decimal('12.01'), 1);
    } catch (error) {
      caught = error;
    }
    if (!isBusinessError(caught)) throw new Error('expected business rejection');
    expect(caught.code).toBe('billing.insufficient_balance');
    expect(caught.category).toBe('quota_exhausted');
    expect(caught.context).toEqual({
      userId: 1,
      available: '12',
      required: '12.01',
      currency: 'CNY',
    });

    expectBusinessCode(
      () => assertCanDebit(account, new Decimal('7.01'), 1, { allowCredit: false }),
      'billing.insufficient_cash',
    );
  });

  it('恰好等额放行（边界：< 与 ≤）', () => {
    expect(() => assertCanDebit(account, new Decimal('12'), 1)).not.toThrow();
    expect(() =>
      assertCanDebit(account, new Decimal('7'), 1, { allowCredit: false }),
    ).not.toThrow();
  });

  it('新授信必须覆盖负余额与在途', () => {
    const negative = { balance: '-8', inFlight: '2', currency: 'CNY' };
    expectBusinessCode(
      () => assertCreditLimitCoversExposure(negative, new Decimal('9'), 1),
      'billing.credit_limit_conflict',
    );
    expect(() => assertCreditLimitCoversExposure(negative, new Decimal('10'), 1)).not.toThrow();
  });
});
