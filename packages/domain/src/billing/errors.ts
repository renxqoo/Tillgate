/**
 * billing 域错误家谱：授权/限额/状态机/不变量四档语义。
 * 订阅来源闸的拒绝（Required/Forbidden/QuotaExhausted/Member*）也归本家谱——
 * 它们是「授权预扣管线」的闸门语义，不是订阅生命周期错误。
 */
export class BillingStateConflictError extends Error {
  constructor(
    public readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingStateConflictError';
  }
}

/** 账本不变量破坏（红灯）：预扣投影与账单事实脱节——确定性失败，重试不可自愈 */
export class BillingInvariantError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'BillingInvariantError';
  }
}

/** 用户级/Key 级每日花费上限（防羊毛党细水长流） */
export class DailySpendLimitExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly limit: string,
    public readonly projected: string,
    public readonly scope: 'user' | 'key' = 'user',
    public readonly apiKeyId: number | null = null,
  ) {
    super(scope === 'key' ? `daily spend limit exceeded for key ${apiKeyId}` : `daily spend limit exceeded for user ${userId}`);
    this.name = 'DailySpendLimitExceededError';
  }
}

/** 成员日限（a）：org 套餐内单日封顶，硬顶不溢出共享 */
export class MemberDailyLimitExceededError extends Error {
  constructor(public readonly userId: number) {
    super(`member daily spend limit exceeded for user ${userId}`);
    this.name = 'MemberDailyLimitExceededError';
  }
}

/** 成员子配额（b）：共享额度池中分到的月度上限 */
export class MemberQuotaExceededError extends Error {
  constructor(public readonly userId: number) {
    super(`member monthly quota exceeded for user ${userId}`);
    this.name = 'MemberQuotaExceededError';
  }
}

/** 凭证绑定的订阅：请求者既非 owner 也非 org active 成员 → 拒绝 */
export class SubscriptionForbiddenError extends Error {
  constructor(public readonly userId: number, public readonly subscriptionId: number) {
    super(`subscription ${subscriptionId} not allowed for user ${userId}`);
    this.name = 'SubscriptionForbiddenError';
  }
}

/** 包月凭证无有效订阅（未订阅/已到期） */
export class SubscriptionRequiredError extends Error {
  constructor(public readonly userId: number) {
    super(`no active subscription for user ${userId}`);
    this.name = 'SubscriptionRequiredError';
  }
}

/** 套餐剩余额度硬顶（额度永不为负） */
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

/** 结算积压准入：settlement 堆积过深/过老时关闭新请求（结算系统自我保护） */
export class BillingBacklogError extends Error {
  constructor(
    public readonly pending: number,
    public readonly oldestPendingMs: number,
  ) {
    super('billing_settlement_backlog');
    this.name = 'BillingBacklogError';
  }
}

/** 死单复核操作错误（管理端语义：期望版本不匹配/幂等键冲突） */
export class BillingOperationError extends Error {
  constructor(
    public readonly code: 'state_conflict' | 'idempotency_conflict',
  ) {
    super(code);
    this.name = 'BillingOperationError';
  }
}
