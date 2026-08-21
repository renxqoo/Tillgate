/**
 * rating 域错误家谱（计价/收据验收语义）：
 *   - 配置类（BillingConfigurationError）→ 管理面问题：报价矛盾、系数非法、超单请求上限
 *   - 毒收据（PoisonReceiptError / ReceiptUserMismatchError）→ 结算永久失败类（dead 人工）
 * 类型化分类，消费方 instanceof 判定，不靠 message 文本。
 */
export class BillingConfigurationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_quote'
      | 'invalid_coefficient'
      | 'reservation_limit_exceeded'
      | 'invalid_reservation_units'
      | 'invalid_reservation_balance'
      | 'unknown_reservation_strategy',
  ) {
    super(code);
    this.name = 'BillingConfigurationError';
  }
}

/** 收据解码/结构/验收失败（毒收据）：结算永久失败 → dead 人工 */
export class PoisonReceiptError extends Error {
  constructor(message = 'poison_receipt') {
    super(message);
    this.name = 'PoisonReceiptError';
  }
}

/** 收据 userId 与授权账单不一致（毒收据） */
export class ReceiptUserMismatchError extends Error {
  constructor() {
    super('receipt user mismatch');
    this.name = 'ReceiptUserMismatchError';
  }
}
