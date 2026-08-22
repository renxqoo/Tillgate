/**
 * 订阅来源可用额规则（纯函数——闸门语义的 domain 化，原 gateSubscription 本体）：
 * 输入已取好的快照（订阅行 + 成员限额 + 已花/在途），输出「订阅此刻最多能出多少」。
 *
 *   结构性非法（无有效订阅/越权）→ 抛错，与开关无关
 *   开关 OFF + 覆盖不足 → 按绑定约束抛错整单拒绝（判定次序 daily → monthly → quota）
 *   开关 ON  + 覆盖不足 → 返回余量（≥0），缺口留给后续来源补差
 * 成员限额保护组织订阅池（只约束订阅份额）；查询编排在使用方（SubscriptionSource.probe）。
 */
import { Decimal } from '../money.js';
import { BillingErrors } from '../errors.js';

export interface SubscriptionGateSnapshot {
  /** null = 无有效订阅（未订阅/已到期） */
  subscription: {
    ownerId: number;
    orgId: number | null;
    quotaAmount: string;
    usedAmount: string;
    reservedAmount: string;
  } | null;
  /** 非本人时解析的 org 成员限额；owner 路径 / 无成员资格传 null（null+非 owner = 越权） */
  membership: { dailySpendLimit: string | null; monthlyQuota: string | null } | null;
  /** 本地自然日已结算花费（成员日限口径；无成员限额传 null） */
  dailySpent: string | null;
  /** 本月已结算花费（成员月配额口径） */
  monthlySpent: string | null;
  /** 本请求之外的在途预扣（订阅口径） */
  exposure: string | null;
}

export interface SubscriptionGateInput {
  userId: number;
  subscriptionId: number;
  amount: string;
  /** 包月额度耗尽自动转 PAYG（api_keys.allow_payg_fallback） */
  allowPaygFallback: boolean;
}

/** 防御性 clamp：异常数据（used + reserved > quota）不得产生负可用额 */
function clampNonNegative(value: Decimal): Decimal {
  return value.lt(0) ? new Decimal(0) : value;
}

export function subscriptionAvailability(
  snapshot: SubscriptionGateSnapshot,
  input: SubscriptionGateInput,
): Decimal {
  const sub = snapshot.subscription;
  if (!sub) {
    throw BillingErrors.business('subscription_required', { userId: input.userId });
  }
  if (sub.ownerId !== input.userId && snapshot.membership == null) {
    throw BillingErrors.business('subscription_forbidden', {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
    });
  }

  const quotaRemaining = clampNonNegative(
    new Decimal(sub.quotaAmount).minus(sub.usedAmount).minus(sub.reservedAmount),
  );
  let availability = quotaRemaining;
  let dailyRemaining: Decimal | null = null;
  let monthlyRemaining: Decimal | null = null;
  if (snapshot.membership != null && sub.ownerId !== input.userId) {
    if (
      snapshot.membership.dailySpendLimit != null &&
      snapshot.dailySpent != null &&
      snapshot.exposure != null
    ) {
      dailyRemaining = clampNonNegative(
        new Decimal(snapshot.membership.dailySpendLimit)
          .minus(snapshot.dailySpent)
          .minus(snapshot.exposure),
      );
      availability = Decimal.min(availability, dailyRemaining);
    }
    if (
      snapshot.membership.monthlyQuota != null &&
      snapshot.monthlySpent != null &&
      snapshot.exposure != null
    ) {
      monthlyRemaining = clampNonNegative(
        new Decimal(snapshot.membership.monthlyQuota)
          .minus(snapshot.monthlySpent)
          .minus(snapshot.exposure),
      );
      availability = Decimal.min(availability, monthlyRemaining);
    }
  }

  const need = new Decimal(input.amount);
  if (availability.lt(need) && !input.allowPaygFallback) {
    if (dailyRemaining != null && dailyRemaining.lt(need)) {
      throw BillingErrors.business('member_daily_limit', { userId: input.userId });
    }
    if (monthlyRemaining != null && monthlyRemaining.lt(need)) {
      throw BillingErrors.business('member_monthly_quota', { userId: input.userId });
    }
    throw BillingErrors.business('subscription_quota_exhausted', {
      userId: input.userId,
      remaining: availability.toString(),
      requested: input.amount,
    });
  }
  return availability;
}
