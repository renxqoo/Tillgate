/**
 * 过账结构校验行为规格（迁移自旧仓 domain/wallet/__tests__/posting.test.ts 复式定律部分；
 * 敞口守卫拆至 exposure.test.ts、指纹拆至 fingerprint.test.ts——旧「undefined 丢弃同指纹」
 * 用例随 B4 修复反转）。
 */
import { describe, expect, it } from 'vitest';
import { isDefectError } from '@tillgate/errors';
import { Decimal } from '../src/domain/money.js';
import {
  isAuditKind,
  legBalanceAfter,
  validatePosting,
  type PostingSpec,
} from '../src/domain/wallet/posting.js';

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

/** 不变量破坏 = 红灯缺陷（DefectError + 码），不再是业务错误类 */
function expectInvariant(fn: () => void): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isDefectError(caught)) throw new Error('expected DefectError rejection');
  expect((caught as { code: string }).code).toBe('billing.wallet_invariant');
}

describe('validatePosting（复式定律）', () => {
  it('平衡双腿通过', () => {
    expect(() => validatePosting(spec(), locked)).not.toThrow();
  });

  it('不平账拒绝（Σ 腿 ≠ 0）', () => {
    expectInvariant(() =>
      validatePosting(
        spec({
          legs: [
            { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
            { accountId: 'b', currency: 'CNY', amount: new Decimal('-0.9') },
          ],
        }),
        locked,
      ),
    );
  });

  it('腿数不足拒绝（业务交易 ≥ 2）', () => {
    expectInvariant(() =>
      validatePosting(
        spec({ legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('0') }] }),
        locked,
      ),
    );
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
    expectInvariant(() =>
      validatePosting(
        { ...audit, legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('1') }] },
        locked,
      ),
    );
    // 审计回执字段缺失拒绝
    expectInvariant(() => validatePosting({ ...audit, creditLimitAfter: undefined }, locked));
  });

  it('账户未锁 / 重复账户 / 币种不一致拒绝', () => {
    expectInvariant(() =>
      validatePosting(
        spec({
          legs: [
            { accountId: 'x', currency: 'CNY', amount: new Decimal('1') },
            { accountId: 'b', currency: 'CNY', amount: new Decimal('-1') },
          ],
        }),
        locked,
      ),
    );
    expectInvariant(() =>
      validatePosting(
        spec({
          legs: [
            { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
            { accountId: 'a', currency: 'CNY', amount: new Decimal('-1') },
          ],
        }),
        locked,
      ),
    );
    expectInvariant(() =>
      validatePosting(
        spec({
          legs: [
            { accountId: 'a', currency: 'CNY', amount: new Decimal('1') },
            { accountId: 'b', currency: 'USD', amount: new Decimal('-1') },
          ],
        }),
        locked,
      ),
    );
  });

  it('freeze 审计交易回执字段（frozenAfter）必填', () => {
    const freeze: PostingSpec = {
      kind: 'freeze',
      refType: 'admin',
      refId: 'r3',
      commandFingerprint: 'f',
      legs: [{ accountId: 'a', currency: 'CNY', amount: new Decimal('0') }],
    };
    expectInvariant(() => validatePosting(freeze, locked));
    expect(() => validatePosting({ ...freeze, frozenAfter: true }, locked)).not.toThrow();
  });

  it('腿链恒等：after = before + amount', () => {
    expect(legBalanceAfter('10.5', new Decimal('-0.5'))).toBe('10');
  });

  it('isAuditKind 词表封闭：credit_line/freeze 为审计交易', () => {
    expect(isAuditKind('credit_line')).toBe(true);
    expect(isAuditKind('freeze')).toBe(true);
    expect(isAuditKind('credit')).toBe(false);
    expect(isAuditKind('settle')).toBe(false);
    expect(isAuditKind('refund')).toBe(false);
    expect(isAuditKind('transfer')).toBe(false);
  });
});
