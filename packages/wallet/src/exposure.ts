/** 账户资金敞口：所有出账与授信调整必须共享同一口径。 */
import { Decimal, toStorage } from './money';
import { CreditLimitConflictError, InsufficientBalanceError, InsufficientCashError } from './errors';
import type { LockedAccount } from './account';

/** 出账守卫选项：allowCredit:false = 现金口径（授信地板不参与可用额）。 */
export interface DebitGuard {
  allowCredit?: boolean;
}

/** 可继续承诺/支出的金额：余额 + 用户授信 - active 冻结（现金口径时授信不计）。 */
export function availableToSpend(
  account: Pick<LockedAccount, 'kind' | 'balance' | 'creditLimit' | 'inFlight'>,
  guard: DebitGuard = {},
): Decimal {
  const credit =
    guard.allowCredit === false || account.kind !== 'user'
      ? new Decimal(0)
      : new Decimal(account.creditLimit);
  return new Decimal(account.balance).plus(credit).minus(account.inFlight);
}

export function assertCanDebit(
  account: Pick<LockedAccount, 'kind' | 'currency' | 'balance' | 'creditLimit' | 'inFlight'>,
  amount: Decimal,
  userId: number,
  guard: DebitGuard = {},
): void {
  const available = availableToSpend(account, guard);
  if (!available.lt(amount)) return;
  if (guard.allowCredit === false) {
    throw new InsufficientCashError(
      userId,
      toStorage(available),
      toStorage(amount),
      account.currency,
    );
  }
  throw new InsufficientBalanceError(
    userId,
    toStorage(available),
    toStorage(amount),
    account.currency,
  );
}

/** 新授信也必须覆盖当前负余额和所有 active 冻结。 */
export function assertCreditLimitCoversExposure(
  account: Pick<LockedAccount, 'balance' | 'inFlight' | 'currency'>,
  newLimit: Decimal,
  userId: number,
): void {
  if (new Decimal(account.balance).plus(newLimit).minus(account.inFlight).lt(0)) {
    throw new CreditLimitConflictError(
      userId,
      account.currency,
      account.balance,
      toStorage(newLimit),
    );
  }
}
