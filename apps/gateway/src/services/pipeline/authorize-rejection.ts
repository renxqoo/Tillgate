import {
  BillingBacklogError,
  BillingConfigurationError,
  BillingStateConflictError,
  DailySpendLimitExceededError,
  InsufficientBalanceError,
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '@ai-gateway/ledger';

/**
 * 授权拒绝的统一翻译（错误语义分级第 6 条的单一真相）：
 * billing 层抛出的领域异常 → HTTP 语义（状态码 + 业务码 + 可读文案）。
 *
 * 纯函数、表驱动：新增拒绝类型只加一行表项，不再在管线里堆 instanceof 分支。
 * 返回 null = 未分类异常（真正的服务端故障）→ 调用方释放预占后原样上抛。
 */

export interface AuthorizeRejection {
  code: string;
  status: 402 | 409 | 422 | 503;
  message: string;
  suggestion?: string;
  /** 附带日志负载（如 backlog 拒绝需记录积压深度）——调用方按需输出 */
  log?: Record<string, unknown>;
}

interface RejectionEntry {
  match: (error: unknown) => boolean;
  build: (error: never, ctx: RejectionContext) => AuthorizeRejection;
}

export interface RejectionContext {
  /** 本次请求的预扣估算（元，字符串形式，用于余额不足文案） */
  maxEstimate: string;
  /** 单请求预扣上限（env.BILLING_RESERVATION_MAX） */
  reservationMax: string;
}

// prettier-ignore 保持表结构可逐行审阅
const REJECTION_TABLE: RejectionEntry[] = [
  {
    match: (e): boolean => e instanceof InsufficientBalanceError,
    build: (e, ctx): AuthorizeRejection => ({
      code: 'insufficient_balance',
      status: 402,
      message: `可用余额不足（当前余额 ${(e as InsufficientBalanceError).balance} 元，需要预扣 ${ctx.maxEstimate} 元）`,
      suggestion: '请充值后再试',
    }),
  },
  {
    match: (e): boolean => e instanceof DailySpendLimitExceededError,
    build: (e): AuthorizeRejection => {
      const err = e as DailySpendLimitExceededError;
      const scope = err.scope === 'key' ? `该 Key（#${err.apiKeyId}）今日` : '今日';
      return {
        code: 'daily_spend_limit_exceeded',
        status: 402,
        message: `${scope}花费已达上限（上限 ${err.dailySpendLimit} 元，当前预计 ${err.projected} 元）`,
        suggestion: '请明天再试，或联系管理员调整每日花费上限',
      };
    },
  },
  {
    match: (e): boolean => e instanceof MemberDailyLimitExceededError,
    build: (e): AuthorizeRejection => {
      const err = e as MemberDailyLimitExceededError;
      return {
        code: 'member_daily_limit',
        status: 402,
        message: `本日花费已达上限（上限 ${err.dailySpendLimit} 元，当前预计 ${err.projected} 元）`,
        suggestion: '请联系组织管理员调整每日上限，或明日再试',
      };
    },
  },
  {
    match: (e): boolean => e instanceof MemberQuotaExceededError,
    build: (e): AuthorizeRejection => {
      const err = e as MemberQuotaExceededError;
      return {
        code: 'member_quota_exceeded',
        status: 402,
        message: `本月配额已用完（配额 ${err.monthlyQuota} 元，当前预计 ${err.projected} 元）`,
        suggestion: '请联系组织管理员调整配额',
      };
    },
  },
  {
    match: (e): boolean => e instanceof SubscriptionRequiredError,
    build: (): AuthorizeRejection => ({
      code: 'subscription_required',
      status: 402,
      message: '无有效订阅（未订阅或已到期）',
      suggestion: '请先订阅或续费后再使用',
    }),
  },
  {
    match: (e): boolean => e instanceof SubscriptionQuotaExhaustedError,
    build: (e): AuthorizeRejection => {
      const err = e as SubscriptionQuotaExhaustedError;
      return {
        code: 'subscription_quota_exhausted',
        status: 402,
        message: `套餐额度已用完（剩余 ${err.remaining} 元，本次预估 ${err.requested} 元）`,
        suggestion: '请升级套餐、续费或扩容后再使用',
      };
    },
  },
  {
    match: (e): boolean => e instanceof SubscriptionForbiddenError,
    build: (): AuthorizeRejection => ({
      code: 'subscription_forbidden',
      status: 402,
      message: '当前凭证绑定的订阅无权使用（非 owner 或非组织成员）',
      suggestion: '请改用绑定到你有权订阅的凭证',
    }),
  },
  {
    match: (e): boolean => e instanceof BillingConfigurationError,
    build: (e, ctx): AuthorizeRejection => {
      const err = e as BillingConfigurationError;
      const overLimit = err.code === 'reservation_limit_exceeded';
      return {
        code: err.code,
        status: overLimit ? 422 : 503,
        message: overLimit
          ? `请求最大费用 ${ctx.maxEstimate} 元超过单请求上限 ${ctx.reservationMax} 元`
          : '模型计费配置无效',
        suggestion: overLimit
          ? '请降低最大输出 token 数后重试'
          : '请联系管理员检查模型价格与费率卡',
      };
    },
  },
  {
    match: (e): boolean => e instanceof BillingStateConflictError,
    build: (e): AuthorizeRejection => {
      const err = e as BillingStateConflictError;
      return {
        code: 'authorization_conflict',
        status: 409,
        message: `请求 ID 已存在内容不同的授权记录（${err.requestId}）`,
        suggestion: '同一请求重试请保持请求体不变，或更换 x-request-id 后重试',
      };
    },
  },
  {
    match: (e): boolean => e instanceof BillingBacklogError,
    build: (e): AuthorizeRejection => {
      const err = e as BillingBacklogError;
      return {
        code: 'billing_temporarily_unavailable',
        status: 503,
        message: '计费结算服务暂时繁忙，为保护资金准确性已暂停新请求',
        suggestion: '请稍后重试',
        log: { pending: err.pending, oldestPendingMs: err.oldestPendingMs },
      };
    },
  },
];

/** 授权异常 → 拒绝语义；null = 未分类（服务端故障，调用方上抛） */
export function mapAuthorizeRejection(
  error: unknown,
  ctx: RejectionContext,
): AuthorizeRejection | null {
  for (const entry of REJECTION_TABLE) {
    if (entry.match(error)) return entry.build(error as never, ctx);
  }
  return null;
}
