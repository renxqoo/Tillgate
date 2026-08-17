// wallet 错误面契约 → 模块化测试（源自 wallet.test.ts 拆分）

import { AuthorizationNotActiveError, AuthorizationNotFoundError, CreditLimitConflictError, CurrencyMismatchError, FrozenAccountError, InsufficientBalanceError, InvalidAccountRefError, InvalidAmountError, RefKeyConflictError, SameAccountTransferError, SettleExceedsHoldError, WalletError, WalletInternalError } from '../index';
import { describe, expect, it } from 'vitest';
describe('错误面契约', () => {
  it('所有公开错误均为 WalletError 子类且 code 全局唯一——外部可凭 code 精确分流', () => {
    const samples: Array<{ error: WalletError; code: string }> = [
      { error: new InvalidAmountError('x'), code: 'invalid_amount' },
      { error: new InvalidAccountRefError('x'), code: 'invalid_account_ref' },
      { error: new InsufficientBalanceError(1, '0', '1'), code: 'insufficient_balance' },
      { error: new AuthorizationNotFoundError('a', 'b'), code: 'authorization_not_found' },
      { error: new AuthorizationNotActiveError('a', 'b', 'settled'), code: 'authorization_not_active' },
      { error: new SettleExceedsHoldError('1', '2'), code: 'settle_exceeds_hold' },
      { error: new RefKeyConflictError('a', 'b', 1), code: 'ref_key_conflict' },
      { error: new CreditLimitConflictError(1, 'CNY', '0', '0'), code: 'credit_limit_conflict' },
      { error: new FrozenAccountError('uuid'), code: 'account_frozen' },
      { error: new SameAccountTransferError('uuid'), code: 'same_account_transfer' },
      { error: new CurrencyMismatchError('CNY', 'USD'), code: 'currency_mismatch' },
      { error: new WalletInternalError('credit.insert'), code: 'internal_error' },
    ];
    const codes = new Set<string>();
    for (const { error, code } of samples) {
      expect(error).toBeInstanceOf(WalletError);
      expect(error.code).toBe(code);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
    }
  });
});
