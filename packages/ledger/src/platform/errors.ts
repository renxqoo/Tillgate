/**
 * platform：账本域错误单一家谱（code 全局唯一，全部类型化；HTTP 映射在 apps 边界）。
 *
 * 语义分级（消费方翻译职责，不在包内做 HTTP）：
 *   - 授权/额度/限额类（Insufficient、DailySpend、Member 系、Subscription 系）→
 *     网关侧 translateAuthorizeError 翻译为 402/422（gateway lib/errors.ts）；
 *   - 配置类（BillingConfigurationError）→ 422/503；
 *   - 状态机冲突（BillingStateConflictError）→ 409；
 *   - 积压准入（BillingBacklogError）→ 503（附积压深度日志负载）；
 *   - 收据校验（ReceiptUserMismatchError/PoisonReceiptError）→ 结算侧
 *     永久失败类（poison_receipt → dead 人工）。
 * 自 billing/errors.ts 上移（2026-08-18，ledger 解体重写 S2）——类对象与语义
 * 原样迁移，消费方 instanceof/name 判定不受影响。
 */

/** 报价/系数/单请求上限配置无效（管理员配置面问题，非用户余额问题） */
export class BillingConfigurationError extends Error {
  constructor(
    public readonly code: 'invalid_quote' | 'invalid_coefficient' | 'reservation_limit_exceeded',
  ) {
    super(code);
    this.name = 'BillingConfigurationError';
  }
}

/**
 * 领域业务拒绝（订阅/调账等业务码唯一真相；自 ledger.ts 上移 S3）。
 * HTTP 映射见 platform/http.ts（LEDGER_HTTP，编译期穷尽）。
 */
export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'user_not_found'
      | 'invalid_amount'
      | 'idempotency_conflict'
      | 'already_subscribed'
      | 'plan_not_found'
      | 'plan_disabled'
      | 'no_subscription'
      | 'downgrade_not_allowed'
      | 'invalid_quantity'
      | 'not_a_pack'
      | 'seats_not_allowed'
      | 'enterprise_required'
      | 'plan_not_purchasable'
      | 'subscription_inactive',
    message: string = code,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** channel-budget 域业务拒绝（自 admin channel-funds 上移 S4；HTTP 映射见 platform/http.ts） */
export class ChannelBudgetError extends Error {
  constructor(
    public readonly code: 'channel_not_found' | 'insufficient_budget',
    message: string = code,
  ) {
    super(message);
    this.name = 'ChannelBudgetError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly userId: number,
    /** 可用信用 = settledBalance + creditLimit - reservedBalance（请求被拒时的可透支额度） */
    public readonly balance: string,
    public readonly settledBalance = balance,
    public readonly reservedBalance = '0',
    public readonly creditLimit = '0',
  ) {
    super(`insufficient balance for user ${userId}: ${balance}`);
    this.name = 'InsufficientBalanceError';
  }
}

/** 状态机冲突：请求 ID 重放指纹不符 / 终态上落收据 / 可预留状态外预留敞口 */
export class BillingStateConflictError extends Error {
  constructor(
    public readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingStateConflictError';
  }
}

export class DailySpendLimitExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly dailySpendLimit: string,
    public readonly projected: string,
    /** 超限维度：user=用户级 / key=Key 级（团队团员） */
    public readonly scope: 'user' | 'key' = 'user',
    public readonly apiKeyId: number | null = null,
  ) {
    super(
      scope === 'key'
        ? `daily spend limit exceeded for key ${apiKeyId} (user ${userId})`
        : `daily spend limit exceeded for user ${userId}`,
    );
    this.name = 'DailySpendLimitExceededError';
  }
}

export class ChannelBudgetExceededError extends Error {
  constructor(
    public readonly channelId: number,
    public readonly remaining: string,
    public readonly requested: string,
  ) {
    super(`channel upstream budget exceeded for channel ${channelId}`);
    this.name = 'ChannelBudgetExceededError';
  }
}

export class SubscriptionQuotaExhaustedError extends Error {
  constructor(
    public readonly userId: number,
    public readonly remaining: string,
    public readonly requested: string,
  ) {
    super(`subscription quota exhausted for user ${userId}`);
    this.name = 'SubscriptionQuotaExhaustedError';
  }
}

/** 成员日限（a）：该成员在 org 套餐内单日封顶，硬顶 402，不溢出共享。 */
export class MemberDailyLimitExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly dailySpendLimit: string,
    public readonly projected: string,
  ) {
    super(`member daily spend limit exceeded for user ${userId}`);
    this.name = 'MemberDailyLimitExceededError';
  }
}

/** 成员子配额（b）：该成员在共享额度池中分到的额度上限，硬顶 402，不溢出共享。 */
export class MemberQuotaExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly monthlyQuota: string,
    public readonly projected: string,
  ) {
    super(`member monthly quota exceeded for user ${userId}`);
    this.name = 'MemberQuotaExceededError';
  }
}

/** 防御：凭证绑定的订阅，用户既非 owner 也非该订阅 org 的 active 成员 → 拒绝。 */
export class SubscriptionForbiddenError extends Error {
  constructor(
    public readonly userId: number,
    public readonly subscriptionId: number,
  ) {
    super(`subscription ${subscriptionId} not allowed for user ${userId}`);
    this.name = 'SubscriptionForbiddenError';
  }
}

/** 包月 Key 无有效订阅（未订阅或已到期）：计费域隔离下仅 subscription Key 触发。 */
export class SubscriptionRequiredError extends Error {
  constructor(public readonly userId: number) {
    super(`no active subscription for user ${userId}`);
    this.name = 'SubscriptionRequiredError';
  }
}

/** 结算积压准入：settlement_pending 堆积过深/过老时关闭新请求（结算系统自我保护） */
export class BillingBacklogError extends Error {
  constructor(
    public readonly pending: number,
    public readonly oldestPendingMs: number,
  ) {
    super('billing_settlement_backlog');
    this.name = 'BillingBacklogError';
  }
}

/** 收据 userId 与授权账单不一致（毒收据分类：结算侧永久失败 → dead 人工） */
export class ReceiptUserMismatchError extends Error {
  constructor() {
    super('receipt user mismatch');
    this.name = 'ReceiptUserMismatchError';
  }
}

/** 收据解码/结构/验收失败（毒收据）：结算永久失败类 → dead 人工（分类按类型，不按 message 文本） */
export class PoisonReceiptError extends Error {
  constructor(message = 'poison_receipt') {
    super(message);
    this.name = 'PoisonReceiptError';
  }
}

/**
 * 账本不变量破坏（红灯）：资金投影与账单事实脱节——预扣守卫 0 行命中
 * （reserved_balance / 套餐 / 渠道投影低于账单预扣）、幂等唯一键冲突、
 * 额度封顶溢出等。全部是确定性失败：重试不可能自愈，classifyFailure 归
 * invariant_violation → 首次失败即 dead 转人工复核，不产生重试 churn。
 */
export class BillingInvariantError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'BillingInvariantError';
  }
}
