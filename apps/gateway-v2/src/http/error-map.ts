/**
 * 领域错误 → HTTP 信封翻译表（routes 层唯一职责之一）。
 * 业务异常在 domain 抛出；这里只做协议映射——语义分级见 domain 各 errors 头注释。
 */
import {
  AuthorizationNotActiveError,
  BillingBacklogError,
  BillingConfigurationError,
  BillingInvariantError,
  BillingStateConflictError,
  ChannelExposureInvariantError,
  DailySpendLimitExceededError,
  FrozenAccountError,
  IdempotencyConflictError,
  InvalidAmountError,
  InvalidRefError,
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  OperationConflictError,
  OperationIdInvalidError,
  PoisonReceiptError,
  ReceiptUserMismatchError,
  RefKeyConflictError,
  SettleExceedsHoldError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
  WalletError,
  WalletInvariantError,
  InsufficientBalanceError,
  InsufficientCashError,
} from '@ai-gateway/domain';
import { RateLimitUnavailableError, AuthGuardUnavailableError } from '@ai-gateway/core';

/** app 协议层错误（无领域对应——模型不存在/费率卡停用等编排期拒绝） */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** app 层鉴权拒绝（无领域对应——协议层语义） */
export class UnauthorizedError extends Error {
  constructor(message = 'invalid api key') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

interface HttpMapping {
  status: number;
  /** 信封错误码（对外稳定契约，登记在本表即冻结） */
  code: string;
}

const BY_INSTANCE: Array<[new (...args: never[]) => Error, HttpMapping]> = [
  // 输入类 → 400
  [InvalidAmountError as never, { status: 400, code: 'invalid_amount' }],
  [InvalidRefError as never, { status: 400, code: 'invalid_ref' }],
  [OperationIdInvalidError as never, { status: 400, code: 'invalid_operation_id' }],
  // 拒绝类（资金/限额/订阅闸）→ 402/403
  [InsufficientBalanceError as never, { status: 402, code: 'insufficient_balance' }],
  [InsufficientCashError as never, { status: 402, code: 'insufficient_cash' }],
  [DailySpendLimitExceededError as never, { status: 402, code: 'daily_spend_limit_exceeded' }],
  [MemberDailyLimitExceededError as never, { status: 402, code: 'member_daily_limit_exceeded' }],
  [MemberQuotaExceededError as never, { status: 402, code: 'member_quota_exceeded' }],
  [SubscriptionRequiredError as never, { status: 402, code: 'subscription_required' }],
  [SubscriptionQuotaExhaustedError as never, { status: 402, code: 'subscription_quota_exhausted' }],
  [BillingBacklogError as never, { status: 503, code: 'billing_backlog' }],
  // Redis 首选组件故障（fail-closed）：限流/防护不可用 → 503 拒绝（不放行裸奔）
  [RateLimitUnavailableError as never, { status: 503, code: 'rate_limiter_unavailable' }],
  [AuthGuardUnavailableError as never, { status: 503, code: 'auth_guard_unavailable' }],
  [SubscriptionForbiddenError as never, { status: 403, code: 'subscription_forbidden' }],
  [FrozenAccountError as never, { status: 403, code: 'account_frozen' }],
  // 幂等/状态冲突 → 409
  [RefKeyConflictError as never, { status: 409, code: 'ref_key_conflict' }],
  [IdempotencyConflictError as never, { status: 409, code: 'idempotency_conflict' }],
  [OperationConflictError as never, { status: 409, code: 'operation_conflict' }],
  [BillingStateConflictError as never, { status: 409, code: 'billing_state_conflict' }],
  [AuthorizationNotActiveError as never, { status: 409, code: 'authorization_not_active' }],
  // 语义拒绝（收据/配置/超扣）→ 422
  [SettleExceedsHoldError as never, { status: 422, code: 'settle_exceeds_hold' }],
  [PoisonReceiptError as never, { status: 422, code: 'poison_receipt' }],
  [ReceiptUserMismatchError as never, { status: 422, code: 'receipt_user_mismatch' }],
  [BillingConfigurationError as never, { status: 422, code: 'billing_configuration' }],
];

export function mapErrorToHttp(error: unknown): HttpMapping & { message: string } {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof UnauthorizedError) {
    return { status: 401, code: 'unauthorized', message: error.message };
  }
  for (const [type, mapping] of BY_INSTANCE) {
    if (error instanceof type) {
      return { ...mapping, message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (
    error instanceof WalletInvariantError ||
    error instanceof BillingInvariantError ||
    error instanceof ChannelExposureInvariantError
  ) {
    return { status: 500, code: 'invariant_violated', message: 'internal consistency violated' };
  }
  if (error instanceof WalletError) {
    // 家谱新成员未登记 → 兜底 400 并显式登记缺口（不允许静默 500）
    return { status: 400, code: 'wallet_unmapped', message: error.message };
  }
  return { status: 500, code: 'internal_error', message: 'internal error' };
}
