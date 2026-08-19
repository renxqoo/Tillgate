/**
 * 错误信封翻译表：app 协议层错误（会话/账户/Key/兑换/支付）+ domain 资金错误
 * → HTTP {error:{code,message}}。信封错误码是对外稳定契约，登记即冻结。
 */
import {
  FrozenAccountError,
  InsufficientCashError,
  InvalidAmountError,
  InvalidRefError,
  RefKeyConflictError,
  IdempotencyConflictError,
  SubscriptionDomainError,
  WalletError,
  WalletInvariantError,
} from '@ai-gateway/domain';
import { WeakPasswordError } from '@ai-gateway/identity-core';

/** app 编排期拒绝（status + code + message 自带） */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  /** 响应附加头（如 429 的 Retry-After——客户端礼貌退避依据） */
  public readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** 订阅域错误码 → HTTP（语义分级：输入 400 / 状态 404 / 冲突与资格 403/409/422） */
const SUBSCRIPTION_HTTP: Record<string, { status: number; code: string }> = {
  invalid_quantity: { status: 400, code: 'invalid_quantity' },
  user_not_found: { status: 401, code: 'unauthorized' },
  plan_not_found: { status: 404, code: 'plan_not_found' },
  plan_disabled: { status: 422, code: 'plan_disabled' },
  plan_not_purchasable: { status: 422, code: 'plan_not_purchasable' },
  not_a_pack: { status: 400, code: 'not_a_pack' },
  seats_not_allowed: { status: 422, code: 'seats_not_allowed' },
  enterprise_required: { status: 403, code: 'enterprise_required' },
  already_subscribed: { status: 409, code: 'already_subscribed' },
  no_subscription: { status: 404, code: 'no_subscription' },
  downgrade_not_allowed: { status: 422, code: 'downgrade_not_allowed' },
};

interface HttpMapping {
  status: number;
  code: string;
}

const BY_INSTANCE: Array<[new (...args: never[]) => Error, HttpMapping]> = [
  // 密码策略（identity-core 家谱）→ 400
  [WeakPasswordError as never, { status: 400, code: 'weak_password' }],
  // 输入/金额 → 400
  [InvalidAmountError as never, { status: 400, code: 'invalid_amount' }],
  [InvalidRefError as never, { status: 400, code: 'invalid_ref' }],
  // 现金不足（订阅购买禁透支）→ 402
  [InsufficientCashError as never, { status: 402, code: 'insufficient_balance' }],
  // 资金幂等/状态冲突 → 409
  [RefKeyConflictError as never, { status: 409, code: 'ref_key_conflict' }],
  [IdempotencyConflictError as never, { status: 409, code: 'idempotency_conflict' }],
  // 账户封禁 → 403
  [FrozenAccountError as never, { status: 403, code: 'account_frozen' }],
];

export function mapErrorToHttp(error: unknown): HttpMapping & { message: string } {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof SubscriptionDomainError) {
    const mapped = SUBSCRIPTION_HTTP[error.code] ?? { status: 400, code: 'subscription_unmapped' };
    return { ...mapped, message: error.message };
  }
  for (const [type, mapping] of BY_INSTANCE) {
    if (error instanceof type) {
      return { ...mapping, message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (error instanceof WalletInvariantError) {
    return { status: 500, code: 'invariant_violated', message: 'internal consistency violated' };
  }
  if (error instanceof WalletError) {
    // 家谱新成员未登记 → 兜底 400 并显式登记缺口（不允许静默 500）
    return { status: 400, code: 'wallet_unmapped', message: error.message };
  }
  return { status: 500, code: 'internal_error', message: 'internal error' };
}
