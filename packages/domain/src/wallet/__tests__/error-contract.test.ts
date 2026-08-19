/** wallet 错误家谱契约：类型化分类（name/code/字段）——上层翻译 HTTP 只认这些形状。 */
import { describe, expect, it } from 'vitest';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  CreditLimitConflictError,
  FrozenAccountError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  InsufficientCashError,
  InvalidRefError,
  RefKeyConflictError,
  SettleExceedsHoldError,
  WalletError,
  WalletInvariantError,
} from '../errors.js';
import { InvalidAmountError } from '../money.js';

describe('wallet 错误家谱', () => {
  it('全部继承 WalletError（instanceof 判定的根）', () => {
    const errors = [
      new InvalidRefError('invalid_ref_type'),
      new InsufficientBalanceError(1, '0', '1', 'CNY'),
      new InsufficientCashError(1, '0', '1', 'CNY'),
      new FrozenAccountError('a1'),
      new RefKeyConflictError('t', 'r', 2),
      new IdempotencyConflictError('t', 'r', 'k'),
      new AuthorizationNotFoundError('t', 'r'),
      new AuthorizationNotActiveError('t', 'r', 'settled'),
      new SettleExceedsHoldError('1', '2'),
      new CreditLimitConflictError(1, 'CNY', '-1', '1'),
      new WalletInvariantError('x'),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(WalletError);
      expect(error).toBeInstanceOf(Error);
      expect(typeof error.code).toBe('string');
    }
  });

  it('余额 vs 现金两类拒绝的 code 语义分档（402 的两个口径）', () => {
    expect(new InsufficientBalanceError(1, '0', '1', 'CNY').code).toBe('insufficient_balance');
    expect(new InsufficientCashError(1, '0', '1', 'CNY').code).toBe('insufficient_cash');
  });

  it('输入类错误的四个 code（refType/refId/currency/科目）', () => {
    for (const code of ['invalid_ref_type', 'invalid_ref_id', 'invalid_currency', 'invalid_internal_code'] as const) {
      expect(new InvalidRefError(code).code).toBe(code);
    }
  });

  it('金额解析错误的 reason 三分档（malformed/non_positive/out_of_scale）', () => {
    expect(new InvalidAmountError('-1', 'non_positive').reason).toBe('non_positive');
    expect(new InvalidAmountError('1e30', 'out_of_scale').reason).toBe('out_of_scale');
  });
});
