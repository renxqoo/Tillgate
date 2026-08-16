import { LedgerError } from './ledger.js';

/**
 * LedgerError → HTTP 语义映射（单一真相）。
 *
 * 此前同一映射在 admin-api/services/subscriptions.ts、client-api/routes/
 * subscriptions.ts、admin-api/services/users.ts 复制了三份且已漂移
 * （no_subscription 两个码名、insufficient_balance 三种状态码）。本表以
 * LedgerError code 联合为键做编译期穷尽映射——新增领域码漏配即编译失败。
 *
 * 消费方（admin-api / client-api）只引用此处，不得再写本地 switch。
 * 错误语义分级：资源不存在 404；余额/状态冲突 402/409；输入 400。
 */
export interface LedgerHttpMapping {
  status: number;
  /** HTTP 错误码（已在 packages/http/src/error-codes.ts 注册表登记） */
  code: string;
  message: string;
}

export const LEDGER_HTTP: Record<LedgerError['code'], LedgerHttpMapping> = {
  user_not_found: { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' },
  insufficient_balance: { status: 402, code: 'INSUFFICIENT_BALANCE', message: '余额不足' },
  invalid_amount: { status: 400, code: 'INVALID_AMOUNT', message: '金额不合法' },
  idempotency_conflict: { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: '幂等键已用于不同请求' },
  already_subscribed: { status: 409, code: 'ALREADY_SUBSCRIBED', message: '已有生效订阅' },
  plan_not_found: { status: 404, code: 'PLAN_NOT_FOUND', message: '套餐不存在' },
  plan_disabled: { status: 400, code: 'PLAN_DISABLED', message: '套餐已下架' },
  plan_not_purchasable: { status: 400, code: 'PLAN_NOT_PURCHASABLE', message: '套餐当前不可购买' },
  no_subscription: { status: 404, code: 'NO_SUBSCRIPTION', message: '当前没有有效订阅' },
  downgrade_not_allowed: { status: 409, code: 'DOWNGRADE_NOT_ALLOWED', message: '不支持降级变更' },
  invalid_quantity: { status: 400, code: 'INVALID_QUANTITY', message: '购买数量不合法' },
  not_a_pack: { status: 400, code: 'NOT_A_PACK', message: '该套餐不是加油包' },
  seats_not_allowed: { status: 400, code: 'SEATS_NOT_ALLOWED', message: '该套餐不支持按席位购买' },
  enterprise_required: { status: 403, code: 'ENTERPRISE_REQUIRED', message: '该操作需要企业版订阅' },
  subscription_inactive: {
    status: 409,
    code: 'SUBSCRIPTION_INACTIVE',
    message: '订阅已被并发取消或替换，操作被拒绝',
  },
};

/** LedgerError → HTTP 映射（未知错误原样上抛，由全局 errorHandler 兜底） */
export function ledgerHttpError(error: unknown): unknown {
  if (error instanceof LedgerError) {
    const mapped = LEDGER_HTTP[error.code];
    return { status: mapped.status, code: mapped.code, message: error.message || mapped.message };
  }
  return error;
}
