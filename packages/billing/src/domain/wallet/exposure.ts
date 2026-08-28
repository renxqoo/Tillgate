/**
 * 出账口径与守卫（纯函数）：所有出账与授信调整共享同一口径——
 * 这是「同一个用户两种算法算出两个可用额」的防线（全包唯一实现）。
 */
import { Decimal, toStorage } from '../money.js';
import { BillingErrors } from '../errors.js';
import type { AccountSnapshot } from './accounts.js';

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
  return new Decimal(account.balance).plus(credit).minus(new Decimal(account.inFlight));
}

/**
 * 原子门守卫口径：SQL WHERE 侧与 availableToSpend
 * 同一代数式的离散形态——'credit' = balance+credit_limit-in_flight，
 * 'cash' = balance-in_flight（allowCredit:false）。口径选择单一真相在此，
 * postgres adapter 的条件占用（conditionalReserve）按本枚举构造 WHERE。
 */
export type GuardKind = 'credit' | 'cash';

export function guardKindOf(guard: DebitGuard): GuardKind {
  return guard.allowCredit === false ? 'cash' : 'credit';
}

/** 出账守卫：可用额不足按口径分流——在途占用/现金/余额三类拒绝（quota_exhausted，充值语义由 face 翻译） */
// eslint-disable-next-line max-params -- 导出域守卫:调用点遍布 wallet 应用层,改签名放大跨模块 diff
export function assertCanDebit(
  account: Pick<AccountSnapshot, 'kind' | 'currency' | 'balance' | 'creditLimit' | 'inFlight'>,
  amount: Decimal,
  userId: number,
  guard: DebitGuard = {},
): void {
  const available = availableToSpend(account, guard);
  if (!available.lt(amount)) return;
  const context = {
    userId,
    available: toStorage(available),
    required: toStorage(amount),
    currency: account.currency,
  };
  // 余额本体足够、仅被在途预扣挤占：分流独立错误码——「充值无济于事，等结算」
  // 与真余额不足的可操作口径不同（重试 vs 充值），混报会误导用户。
  const gross =
    guard.allowCredit === false || account.kind !== 'user'
      ? new Decimal(account.balance)
      : new Decimal(account.balance).plus(new Decimal(account.creditLimit));
  if (gross.gte(amount)) {
    throw BillingErrors.business('funds_held_in_flight', {
      ...context,
      inFlight: account.inFlight,
    });
  }
  if (guard.allowCredit === false) {
    throw BillingErrors.business('insufficient_cash', context);
  }
  throw BillingErrors.business('insufficient_balance', context);
}

/** 新授信必须覆盖当前负余额和所有 active 冻结（balance + newLimit − inFlight ≥ 0） */
export function assertCreditLimitCoversExposure(
  account: Pick<AccountSnapshot, 'balance' | 'inFlight' | 'currency'>,
  newLimit: Decimal,
  userId: number,
): void {
  if (new Decimal(account.balance).plus(newLimit).minus(new Decimal(account.inFlight)).lt(0)) {
    throw BillingErrors.business('credit_limit_conflict', {
      userId,
      currency: account.currency,
      balance: account.balance,
      attemptedLimit: toStorage(newLimit),
    });
  }
}
