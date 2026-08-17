/** wallet 错误类型（错误语义分级：不变量违反 ≠ 状态冲突 ≠ 输入非法） */

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** 输入非法（金额格式/词表越界）——调用方 bug，不应重试 */
export class InvalidAmountError extends WalletError {
  constructor(detail: string) {
    super(`invalid amount: ${detail}`, 'invalid_amount');
    this.name = 'InvalidAmountError';
  }
}

/** 可用余额不足（balance - in_flight < required）——业务拒绝，不重试 */
export class InsufficientBalanceError extends WalletError {
  constructor(
    readonly userId: number,
    readonly available: string,
    readonly required: string,
    readonly currency: string = 'CNY',
  ) {
    super(
      `insufficient ${currency} balance for user ${userId}: available ${available}, required ${required}`,
      'insufficient_balance',
    );
    this.name = 'InsufficientBalanceError';
  }
}

/** 授信调整冲突：新授信额低于当前欠款（|负余额| > 新额度），调低会击穿地板 */
export class CreditLimitConflictError extends WalletError {
  constructor(
    readonly userId: number,
    readonly currency: string,
    readonly balance: string,
    readonly requestedLimit: string,
  ) {
    super(
      `cannot lower credit limit for user ${userId} (${currency}) to ${requestedLimit}: balance ${balance} would breach the floor`,
      'credit_limit_conflict',
    );
    this.name = 'CreditLimitConflictError';
  }
}

/** 账户冻结（风控）：拒绝一切资金变动（查询不受限） */
export class FrozenAccountError extends WalletError {
  constructor(readonly accountId: string) {
    super(`wallet account ${accountId} is frozen`, 'account_frozen');
    this.name = 'FrozenAccountError';
  }
}

/** 转账双方为同一账户 */
export class SameAccountTransferError extends WalletError {
  constructor(readonly accountId: string) {
    super(`transfer from and to resolve to the same account ${accountId}`, 'same_account_transfer');
    this.name = 'SameAccountTransferError';
  }
}

/** 跨币种转账：换汇是业务的两腿操作，单笔 transfer 不做币种转换 */
export class CurrencyMismatchError extends WalletError {
  constructor(readonly from: string, readonly to: string) {
    super(`transfer currency mismatch: ${from} vs ${to}（换汇应为两笔独立转账）`, 'currency_mismatch');
    this.name = 'CurrencyMismatchError';
  }
}

/** 业务键无对应冻结（settle/release 寻址失败）——调用方数据不一致 */
export class AuthorizationNotFoundError extends WalletError {
  constructor(refType: string, refId: string) {
    super(`no authorization for ${refType}/${refId}`, 'authorization_not_found');
    this.name = 'AuthorizationNotFoundError';
  }
}

/** 冻结已不处于 active（settle 已结 frozen、release 已释放等）——状态机冲突 */
export class AuthorizationNotActiveError extends WalletError {
  constructor(
    refType: string,
    refId: string,
    readonly status: string,
  ) {
    super(`authorization ${refType}/${refId} is ${status}, not active`, 'authorization_not_active');
    this.name = 'AuthorizationNotActiveError';
  }
}

/** 结算金额超过冻结额（禁止借 settle 多扣） */
export class SettleExceedsHoldError extends WalletError {
  constructor(
    readonly held: string,
    readonly requested: string,
  ) {
    super(`settle ${requested} exceeds held ${held}`, 'settle_exceeds_hold');
    this.name = 'SettleExceedsHoldError';
  }
}

/**
 * 幂等键跨账户顶撞：同一 (refType, refId) 已属于另一账户。
 * 幂等键全局唯一是调用方的设计责任——本错误是串号事故的最后一道闸
 * （没有它，重放路径会把别人的流水静默当成自己的结果返回）。
 */
export class RefKeyConflictError extends WalletError {
  constructor(
    readonly refType: string,
    readonly refId: string,
    readonly ownerUserId: number,
  ) {
    super(
      `ref key ${refType}/${refId} already belongs to user ${ownerUserId}`,
      'ref_key_conflict',
    );
    this.name = 'RefKeyConflictError';
  }
}
