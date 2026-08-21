/**
 * 账户域规则（纯函数）：引用、可用口径、借记守卫、授信覆盖。
 * 所有出账与授信调整共享同一口径——这是「同一个用户两种算法算出两个可用额」的防线。
 */
import { Decimal, toStorage } from './money.js';
import {
  CreditLimitConflictError,
  InsufficientBalanceError,
  InsufficientCashError,
} from './errors.js';

/** 账户引用：用户（userId）或内部科目（code）二选一 */
export type AccountRef = { userId: number } | { code: string };

/** 仓储行形状（kind/status 为库中字符串；语义判定见下方断言函数） */
export interface AccountSnapshot {
  id: string;
  kind: string;
  code: string | null;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  status: string;
}

/** 出账守卫选项：allowCredit:false = 现金口径（授信地板不参与可用额） */
export interface DebitGuard {
  allowCredit?: boolean;
}

/** 可继续承诺/支出的金额：余额 + 用户授信 − active 冻结（现金口径时授信不计） */
export function availableToSpend(
  account: Pick<AccountSnapshot, 'kind' | 'balance' | 'creditLimit' | 'inFlight'>,
  guard: DebitGuard = {},
): Decimal {
  const credit =
    guard.allowCredit === false || account.kind !== 'user'
      ? new Decimal(0)
      : new Decimal(account.creditLimit);
  return new Decimal(account.balance).plus(credit).minus(account.inFlight);
}

/** 出账守卫：可用额不足按口径分流为现金/余额两类拒绝（402 语义由上层翻译） */
export function assertCanDebit(
  account: Pick<AccountSnapshot, 'kind' | 'currency' | 'balance' | 'creditLimit' | 'inFlight'>,
  amount: Decimal,
  userId: number,
  guard: DebitGuard = {},
): void {
  const available = availableToSpend(account, guard);
  if (!available.lt(amount)) return;
  if (guard.allowCredit === false) {
    throw new InsufficientCashError(userId, toStorage(available), toStorage(amount), account.currency);
  }
  throw new InsufficientBalanceError(userId, toStorage(available), toStorage(amount), account.currency);
}

/** 新授信必须覆盖当前负余额和所有 active 冻结 */
export function assertCreditLimitCoversExposure(
  account: Pick<AccountSnapshot, 'balance' | 'inFlight' | 'currency'>,
  newLimit: Decimal,
  userId: number,
): void {
  if (new Decimal(account.balance).plus(newLimit).minus(account.inFlight).lt(0)) {
    throw new CreditLimitConflictError(userId, account.currency, account.balance, toStorage(newLimit));
  }
}
