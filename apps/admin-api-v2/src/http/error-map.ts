/**
 * 错误信封翻译：AppError（服务编排期拒绝，自带 status/code/message）
 * + 订阅域错误（语义分级：输入 400 / 状态 404 / 冲突与资格 403/409/422）
 * + 资金域错误家谱（domain wallet/errors）
 * + PG 约束错误（唯一/外键/检查/数值域——SQL 下沉 repository 后的兜底翻译）
 * → HTTP {error:{code,message}}。信封错误码是对外稳定契约，登记即冻结。
 */
import {
  FrozenAccountError,
  IdempotencyConflictError,
  InsufficientCashError,
  InvalidAmountError,
  OperationConflictError,
  RefKeyConflictError,
  SubscriptionDomainError,
} from '@ai-gateway/domain';
import { HttpError, errorSpec } from '@ai-gateway/http';

/** app 编排期拒绝（status + code + message 自带） */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  /** 响应附加头（如 429 的 Retry-After） */
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

interface HttpMapping {
  status: number;
  code: string;
}

/** 订阅域错误码 → HTTP（与 client-api-v2 同一分级口径） */
const SUBSCRIPTION_HTTP: Record<string, HttpMapping> = {
  invalid_quantity: { status: 400, code: 'invalid_quantity' },
  user_not_found: { status: 404, code: 'user_not_found' },
  plan_not_found: { status: 404, code: 'plan_not_found' },
  plan_disabled: { status: 400, code: 'plan_disabled' },
  plan_not_purchasable: { status: 400, code: 'plan_not_purchasable' },
  not_a_pack: { status: 400, code: 'not_a_pack' },
  seats_not_allowed: { status: 400, code: 'seats_not_allowed' },
  enterprise_required: { status: 403, code: 'enterprise_required' },
  already_subscribed: { status: 409, code: 'already_subscribed' },
  no_subscription: { status: 404, code: 'no_subscription' },
  downgrade_not_allowed: { status: 409, code: 'downgrade_not_allowed' },
  subscription_inactive: { status: 409, code: 'subscription_inactive' },
};

const BY_INSTANCE: Array<[new (...args: never[]) => Error, HttpMapping]> = [
  // 输入/金额 → 400
  [InvalidAmountError as never, { status: 400, code: 'invalid_amount' }],
  // 现金不足（订阅收款禁透支）→ 402
  [InsufficientCashError as never, { status: 402, code: 'insufficient_balance' }],
  // 账户封禁 → 403
  [FrozenAccountError as never, { status: 403, code: 'account_frozen' }],
  // 资金幂等/状态冲突 → 409
  [RefKeyConflictError as never, { status: 409, code: 'idempotency_conflict' }],
  [IdempotencyConflictError as never, { status: 409, code: 'idempotency_conflict' }],
  [OperationConflictError as never, { status: 409, code: 'idempotency_conflict' }],
];

/** PG 错误码 → HTTP（SQL 唯一允许出现在 repository，约束违例在协议层统一翻译） */
const PG_HTTP: Record<string, HttpMapping> = {
  '23505': { status: 409, code: 'conflict' },
  '23503': { status: 400, code: 'invalid_reference' },
  '23514': { status: 400, code: 'constraint_violation' },
  '22001': { status: 400, code: 'value_too_long' },
  '22P02': { status: 400, code: 'invalid_value' },
  '22003': { status: 400, code: 'value_out_of_range' },
};

export function mapErrorToHttp(error: unknown): HttpMapping & { message: string } {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // 共享组件（http 包）的注册表错误：状态码以注册表为准
  if (error instanceof HttpError) {
    const spec = errorSpec(error.code);
    return { status: spec?.status ?? 400, code: error.code, message: error.message };
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
  // drizzle 会把 PG 错误包进 cause 链——逐层找 PG 错误码
  let node: unknown = error;
  for (let depth = 0; node != null && depth < 5; depth += 1) {
    const pgCode = (node as { code?: unknown }).code;
    if (typeof pgCode === 'string' && pgCode in PG_HTTP) {
      const mapped = PG_HTTP[pgCode]!;
      return { ...mapped, message: '操作违反数据约束（重名/引用/数值域）' };
    }
    node = (node as { cause?: unknown }).cause;
  }
  return { status: 500, code: 'internal_error', message: 'internal error' };
}
