/** 过账结构校验（复式定律的纯函数面）+ 敞口守卫 + 指纹规范化。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../money.js';
import { WalletInvariantError } from '../errors.js';
import { validatePosting, legBalanceAfter, type PostingSpec } from '../posting.js';
import { availableToSpend, assertCanDebit, assertCreditLimitCoversExposure } from '../account.js';
import { InsufficientBalanceError, InsufficientCashError } from '../errors.js';
import { commandFingerprint } from '../fingerprint.js';

const locked = new Set(['a', 'b']);

function spec(overrides: Partial<PostingSpec> = {}): PostingSpec {
  return {
    kind: 'credit',
    refType: 'topup',
    refId: 'r1',
    commandFingerprint: 'f',
    legs: [
      { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
      { accountId: 'b', currency: 'CNY', amount: new Decimal('-1') },
    ],
    ...overrides,
  };
}

describe('validatePosting（复式定律）', () => {
  it('平衡双腿通过', () => {
    expect(() => validatePosting(spec(), locked)).not.toThrow();
  });

  it('不平账拒绝（Σ 腿 ≠ 0）', () => {
    expect(() =>
      validatePosting(
        spec({ legs: [
          { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
          { accountId: 'b', currency: 'CNY', amount: new Decimal('-0.9') },
        ] }),
        locked,
      ),
    ).toThrow(WalletInvariantError);
  });

  it('腿数不足拒绝（业务交易 ≥ 2）', () => {
    expect(() =>
      validatePooling(spec({ legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('0') }] })),
    ).toThrow(WalletInvariantError);
  });

  it('审计交易恰好一条零腿（credit_line/freeze）', () => {
    const audit: PostingSpec = {
      kind: 'credit_line',
      refType: 'admin',
      refId: 'r2',
      commandFingerprint: 'f',
      creditLimitAfter: '10',
      legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('0') }],
    };
    expect(() => validatePosting(audit, locked)).not.toThrow();
    // 非零审计腿拒绝
    expect(() =>
      validatePosting({ ...audit, legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('1') }] }, locked),
    ).toThrow(WalletInvariantError);
    // 审计回执字段缺失拒绝
    expect(() =>
      validatePosting({ ...audit, creditLimitAfter: undefined }, locked),
    ).toThrow(WalletInvariantError);
  });

  it('账户未锁 / 重复账户 / 币种不一致拒绝', () => {
    expect(() =>
      validatePosting(spec({ legs: [
        { accountId: 'x', currency: 'CNY', amount: new Decimal('1') },
        { accountId: 'b', currency: 'CNY', amount: new Decimal('-1') },
      ] }), locked),
    ).toThrow(WalletInvariantError);
    expect(() =>
      validatePosting(spec({ legs: [
        { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
        { accountId: 'a', currency: 'CNY', amount: new Decimal('-1') },
      ] }), locked),
    ).toThrow(WalletInvariantError);
    expect(() =>
      validatePosting(spec({ legs: [
        { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
        { accountId: 'b', currency: 'USD', amount: new Decimal('-1') },
      ] }), locked),
    ).toThrow(WalletInvariantError);
  });

  it('腿链恒等：after = before + amount', () => {
    expect(legBalanceAfter('10.5', new Decimal('-0.5'))).toBe('10');
  });
});

function validatePooling(s: PostingSpec): void {
  validatePosting(s, locked);
}

describe('敞口守卫（同一口径）', () => {
  const account = { kind: 'user', currency: 'CNY', balance: '10', creditLimit: '5', inFlight: '3' };

  it('信用口径：余额 + 授信 − 在途', () => {
    expect(availableToSpend(account).toString()).toBe('12');
  });

  it('现金口径：授信不参与', () => {
    expect(availableToSpend(account, { allowCredit: false }).toString()).toBe('7');
  });

  it('内部科目无授信概念（授信恒 0）', () => {
    expect(availableToSpend({ ...account, kind: 'internal' }).toString()).toBe('7');
  });

  it('不足时按口径分流错误类型', () => {
    expect(() => assertCanDebit(account, new Decimal('12.01'), 1)).toThrow(InsufficientBalanceError);
    expect(() => assertCanDebit(account, new Decimal('7.01'), 1, { allowCredit: false })).toThrow(
      InsufficientCashError,
    );
  });

  it('新授信必须覆盖负余额与在途', () => {
    const negative = { balance: '-8', inFlight: '2', currency: 'CNY' };
    expect(() => assertCreditLimitCoversExposure(negative, new Decimal('9'), 1)).toThrow();
    expect(() => assertCreditLimitCoversExposure(negative, new Decimal('10'), 1)).not.toThrow();
  });
});

describe('命令指纹（canonical）', () => {
  it('键序无关、undefined 丢弃：等价命令同指纹', () => {
    const a = commandFingerprint('credit', { userId: 1, amount: '1', memo: undefined });
    const b = commandFingerprint('credit', { amount: '1', userId: 1 });
    expect(a).toBe(b);
  });

  it('任一实质参数不同则指纹不同', () => {
    const a = commandFingerprint('credit', { userId: 1, amount: '1' });
    const b = commandFingerprint('credit', { userId: 2, amount: '1' });
    const c = commandFingerprint('settle', { userId: 1, amount: '1' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
