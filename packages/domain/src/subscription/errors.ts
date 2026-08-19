/**
 * 订阅域错误家谱：单类携 code（消费方按 code 翻 HTTP；语义分级见各 code 注释）。
 * 输入/状态类（400/404/409）与资格类（403/422）由 app 协议层映射，domain 只判对错。
 */
export type SubscriptionErrorCode =
  | 'invalid_quantity'
  | 'user_not_found'
  | 'plan_not_found'
  | 'plan_disabled'
  | 'plan_not_purchasable'
  | 'not_a_pack'
  | 'seats_not_allowed'
  | 'enterprise_required'
  | 'already_subscribed'
  | 'no_subscription'
  | 'downgrade_not_allowed'
  /** 订阅在操作窗口内被并发取消/替换（账本行级状态守卫命中 0 行） */
  | 'subscription_inactive';

export class SubscriptionDomainError extends Error {
  constructor(
    public readonly code: SubscriptionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SubscriptionDomainError';
  }
}
