import { LedgerError } from '@ai-gateway/ledger';
import { HttpError } from '@ai-gateway/http';

/**
 * 套餐/订阅 ledger 业务错误 → HTTP 错误映射（购买/续费/取消共用）。
 * 非 LedgerError 原样抛出，交给 errorHandler 归一到 500。
 */
export function mapSubscriptionError(error: unknown): HttpError {
  if (error instanceof LedgerError) {
    switch (error.code) {
      case 'already_subscribed':
        return new HttpError(409, 'ALREADY_SUBSCRIBED', '已有有效订阅，请先取消或续费');
      case 'plan_not_found':
        return new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
      case 'plan_disabled':
        return new HttpError(400, 'PLAN_DISABLED', '套餐已停用，无法购买');
      case 'no_subscription':
        return new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在或已失效');
      case 'insufficient_balance':
        return new HttpError(402, 'INSUFFICIENT_BALANCE', '余额不足，无法购买套餐');
      case 'user_not_found':
        return new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
      case 'idempotency_conflict':
        return new HttpError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
    }
  }
  throw error;
}
