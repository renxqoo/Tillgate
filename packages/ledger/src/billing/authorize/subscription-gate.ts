import { and, eq, gt, sql } from 'drizzle-orm';
import {
  billingRequests,
  orgMembers,
  usageLogs,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import type { Decimal } from '@ai-gateway/money';
import { toDecimal } from '@ai-gateway/money';
import type { DbTx } from '../types.js';
import { billingDayStart } from '../daily-window.js';
import {
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '../errors.js';

/**
 * 订阅来源闸（拆自 authorize 事务）：
 *
 *   订阅有效性（status=0 且未到期）→ 防御校验（请求者 = owner 或 org active 成员）
 *   → 成员日限 a（单日封顶）→ 成员子配额 b（月度上限）→ 套餐剩余额度硬顶
 *
 * 限额口径：已结算侧按结算时间归属窗口（usage_logs.created_at）；在途敞口侧
 * **不按创建时间过滤**——跨窗口边界仍在途的请求结算时会落进新窗口的已消费，
 * 敞口侧若按 created_at 过滤两侧口径不对称，限额可被跨日/月界叠加突破。
 *
 * @returns planReservedAmount（= 本次预扣额，落 billing_requests.plan_reserved_amount，
 *          结算按它释放套餐在途敞口）
 */
export async function gateSubscription(
  tx: DbTx,
  now: Date,
  userId: number,
  subscriptionId: number,
  amountDec: Decimal,
  amount: string,
): Promise<string> {
  const sub = await tx.query.userSubscriptions.findFirst({
    where: and(
      eq(userSubscriptions.id, subscriptionId),
      eq(userSubscriptions.status, 0),
      gt(userSubscriptions.endAt, now),
    ),
    columns: {
      id: true,
      userId: true,
      orgId: true,
      quotaAmount: true,
      usedAmount: true,
      reservedAmount: true,
    },
  });
  if (!sub) throw new SubscriptionRequiredError(userId);

  // 防御校验：用户 = 订阅 owner，或该订阅 org 的 active 成员；否则拒绝（防绑到别人套餐）。
  let allowed = sub.userId === userId;
  if (!allowed && sub.orgId != null) {
    const member = await tx.query.orgMembers.findFirst({
      where: and(
        eq(orgMembers.orgId, sub.orgId),
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 0),
      ),
      columns: { dailySpendLimit: true, monthlyQuota: true },
    });
    if (member) {
      allowed = true;
      // 成员日限 a：该成员在 org 套餐内单日封顶（硬顶，不溢出共享）。
      if (member.dailySpendLimit != null) {
        const todayStart = billingDayStart(now);
        const spent = await tx.execute<{ total: string }>(sql`
          select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
          from ${usageLogs}
          where ${usageLogs.userId} = ${userId}
            and ${usageLogs.subscriptionId} = ${subscriptionId}
            and ${usageLogs.status} = 0
            and ${usageLogs.createdAt} >= ${todayStart}
        `);
        const exposure = await tx.execute<{ total: string }>(sql`
          select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
          from ${billingRequests}
          where ${billingRequests.userId} = ${userId}
            and ${billingRequests.subscriptionId} = ${subscriptionId}
            and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','dead')
        `);
        const projected = toDecimal(spent.rows[0]?.total ?? '0')
          .plus(toDecimal(exposure.rows[0]?.total ?? '0'))
          .plus(amountDec);
        if (projected.gt(member.dailySpendLimit)) {
          throw new MemberDailyLimitExceededError(
            userId,
            member.dailySpendLimit,
            projected.toString(),
          );
        }
      }
      // 成员子配额 b：该成员在共享额度池中分到的额度上限（硬顶，不溢出共享）。
      if (member.monthlyQuota != null) {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const spent = await tx.execute<{ total: string }>(sql`
          select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
          from ${usageLogs}
          where ${usageLogs.userId} = ${userId}
            and ${usageLogs.subscriptionId} = ${subscriptionId}
            and ${usageLogs.status} = 0
            and ${usageLogs.createdAt} >= ${monthStart}
        `);
        const exposure = await tx.execute<{ total: string }>(sql`
          select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
          from ${billingRequests}
          where ${billingRequests.userId} = ${userId}
            and ${billingRequests.subscriptionId} = ${subscriptionId}
            and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','dead')
        `);
        const projected = toDecimal(spent.rows[0]?.total ?? '0')
          .plus(toDecimal(exposure.rows[0]?.total ?? '0'))
          .plus(amountDec);
        if (projected.gt(member.monthlyQuota)) {
          throw new MemberQuotaExceededError(userId, member.monthlyQuota, projected.toString());
        }
      }
    }
  }
  if (!allowed) throw new SubscriptionForbiddenError(userId, subscriptionId);

  const remaining = toDecimal(sub.quotaAmount)
    .minus(toDecimal(sub.usedAmount))
    .minus(toDecimal(sub.reservedAmount));
  // 额度硬顶：预估超出剩余额度 → 402（套餐额度永不为负）。
  if (remaining.lt(amountDec)) {
    throw new SubscriptionQuotaExhaustedError(userId, remaining.toString(), amount);
  }
  return amount;
}
