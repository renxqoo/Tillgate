/**
 * wallet 域错误家谱（语义分级，全类型化——上层翻译 HTTP，绝不裸泄漏）：
 *   - 输入类（InvalidRef、InvalidAmount）→ 400 语义
 *   - 拒绝类（InsufficientBalance、InsufficientCash、Frozen、SettleExceedsHold、
 *     CreditLimitConflict）→ 402/403/409 语义
 *   - 幂等冲突（RefKeyConflict、IdempotencyConflict）→ 409 语义
 *   - 不变量（WalletInvariantError）→ 红灯：资金事实脱节，只应出现在缺陷里
 */
export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** 输入结构非法（引用键/币种/科目/过期时间不满足契约或未过白名单） */
export class InvalidRefError extends WalletError {
  constructor(code: 'invalid_ref_type' | 'invalid_ref_id' | 'invalid_currency' | 'invalid_internal_code' | 'invalid_expiry') {
    super(code, code);
    this.name = 'InvalidRefError';
  }
}

/** 可用额不足（信用口径：balance + creditLimit − inFlight < amount）→ 402 */
export class InsufficientBalanceError extends WalletError {
  constructor(
    public readonly userId: number,
    public readonly available: string,
    public readonly required: string,
    public readonly currency: string,
  ) {
    super(`insufficient balance for user ${userId}: available ${available}, required ${required} ${currency}`, 'insufficient_balance');
    this.name = 'InsufficientBalanceError';
  }
}

/** 现金不足（现金口径：balance − in_flight < amount；allowCredit:false）→ 402 */
export class InsufficientCashError extends WalletError {
  constructor(
    public readonly userId: number,
    public readonly available: string,
    public readonly required: string,
    public readonly currency: string,
  ) {
    super(`insufficient cash for user ${userId}: available ${available}, required ${required} ${currency}`, 'insufficient_cash');
    this.name = 'InsufficientCashError';
  }
}

/** 账户风控冻结：拒绝一切资金变动 → 403 */
export class FrozenAccountError extends WalletError {
  constructor(public readonly accountId: string) {
    super(`wallet account ${accountId} is frozen`, 'account_frozen');
    this.name = 'FrozenAccountError';
  }
}

/** 幂等键跨主体顶撞：同 (refType, refId) 被另一用户/币种持有 → 409 */
export class RefKeyConflictError extends WalletError {
  constructor(
    public readonly refType: string,
    public readonly refId: string,
    public readonly ownerUserId: number,
  ) {
    super(`ref key (${refType}, ${refId}) already owned by user ${ownerUserId}`, 'ref_key_conflict');
    this.name = 'RefKeyConflictError';
  }
}

/** 同幂等键不同命令（规范化后不等）→ 409 */
export class IdempotencyConflictError extends WalletError {
  constructor(
    public readonly refType: string,
    public readonly refId: string,
    public readonly kind: string,
  ) {
    super(`idempotency conflict on (${refType}, ${refId}, ${kind})`, 'idempotency_conflict');
    this.name = 'IdempotencyConflictError';
  }
}

export class AuthorizationNotFoundError extends WalletError {
  constructor(
    public readonly refType: string,
    public readonly refId: string,
  ) {
    super(`authorization (${refType}, ${refId}) not found`, 'authorization_not_found');
    this.name = 'AuthorizationNotFoundError';
  }
}

/** 冻结单不在可结算/可释放态（released/expired/已结算后再操作）→ 409 */
export class AuthorizationNotActiveError extends WalletError {
  constructor(
    public readonly refType: string,
    public readonly refId: string,
    public readonly status: string,
  ) {
    super(`authorization (${refType}, ${refId}) not active: ${status}`, 'authorization_not_active');
    this.name = 'AuthorizationNotActiveError';
  }
}

/** 实扣超过冻结额（settle ≤ hold 是内核保证）→ 422 */
export class SettleExceedsHoldError extends WalletError {
  constructor(
    public readonly held: string,
    public readonly requested: string,
  ) {
    super(`settle ${requested} exceeds hold ${held}`, 'settle_exceeds_hold');
    this.name = 'SettleExceedsHoldError';
  }
}

/** 新授信必须覆盖当前敞口（balance + newLimit − inFlight ≥ 0）→ 409 */
export class CreditLimitConflictError extends WalletError {
  constructor(
    public readonly userId: number,
    public readonly currency: string,
    public readonly balance: string,
    public readonly attemptedLimit: string,
  ) {
    super(`credit limit ${attemptedLimit} does not cover exposure (balance ${balance}) for user ${userId}`, 'credit_limit_conflict');
    this.name = 'CreditLimitConflictError';
  }
}

/** 资金不变量破坏（红灯）：腿链断裂/平账失败/守卫脱节——确定性失败，不应被重试掩盖 */
export class WalletInvariantError extends WalletError {
  constructor(
    public readonly detail: string,
  ) {
    super(`wallet invariant violated: ${detail}`, 'wallet_invariant');
    this.name = 'WalletInvariantError';
  }
}
