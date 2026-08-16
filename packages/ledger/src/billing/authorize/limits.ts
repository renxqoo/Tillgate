import { eq, sql } from 'drizzle-orm';
import {
  apiKeys,
  apps,
  billingRequests,
  usageLogs,
  users,
} from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/money';
import type { AuthorizeBillingCommand, DbTx } from '../types.js';
import { billingDayStart } from '../daily-window.js';
import { DailySpendLimitExceededError } from '../errors.js';

/**
 * 每日花费上限（用户级 + Key 级）与计费来源解析（拆自 authorize 事务）。
 *
 * 口径：当期已结算消费(usage_logs.amount，按结算时间归属窗口) + 在途敞口
 * (未终结 billing_requests 的 reserved_amount，**不按创建时间过滤**——跨窗口
 * 边界仍在途的请求结算时会落进新窗口的已消费，敞口侧若按 created_at 过滤
 * 两侧口径不对称，限额可被跨日界叠加突破) + 本次预估 ≤ 上限。
 * RPM/TPM 只挡频率，这里挡「每日总量」。Key 级查询同时读出 subscription_id——
 * 单一查询兼顾限额与来源解析（计费来源以凭证绑定的订阅为准，不信任调用方传参）。
 *
 * @returns subscriptionId（null = 余额来源）
 */
export async function assertDailyLimitsAndResolveSource(
  tx: DbTx,
  now: Date,
  command: AuthorizeBillingCommand,
  amount: string,
): Promise<number | null> {
  // ---- 用户级每日花费上限（防羊毛党「细水长流」）----
  const profile = await tx.query.users.findFirst({
    where: eq(users.id, command.userId),
    columns: { dailySpendLimit: true },
  });
  if (profile && profile.dailySpendLimit !== null) {
    const todayStart = billingDayStart(now);
    // 已结算消费按 usage_logs.amount 统计（含套餐+余额，与 Key 级口径统一）：
    // 套餐覆盖的消耗不再写 consume 流水，改用 usage_logs 才能正确计入「单日总价值消耗」。
    const spentRow = await tx.execute<{ total: string }>(sql`
      select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
      from ${usageLogs}
      where ${usageLogs.userId} = ${command.userId}
        and ${usageLogs.status} = 0
        and ${usageLogs.createdAt} >= ${todayStart}
    `);
    const exposureRow = await tx.execute<{ total: string }>(sql`
      select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
      from ${billingRequests}
      where ${billingRequests.userId} = ${command.userId}
        and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','dead')
    `);
    const projected = toDecimal(spentRow.rows[0]?.total ?? '0')
      .plus(toDecimal(exposureRow.rows[0]?.total ?? '0'))
      .plus(toDecimal(amount));
    if (projected.gt(profile.dailySpendLimit)) {
      throw new DailySpendLimitExceededError(
        command.userId,
        profile.dailySpendLimit,
        projected.toString(),
      );
    }
  }

  // ---- Key 级每日上限 + 订阅绑定 / App 订阅绑定 ----
  let subscriptionId: number | null = null;
  if (command.apiKeyId != null) {
    const key = await tx.query.apiKeys.findFirst({
      where: eq(apiKeys.id, command.apiKeyId),
      columns: { dailySpendLimit: true, subscriptionId: true },
    });
    if (key) subscriptionId = key.subscriptionId;
    if (key && key.dailySpendLimit !== null) {
      const todayStart = billingDayStart(now);
      const keySpentRow = await tx.execute<{ total: string }>(sql`
        select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
        from ${usageLogs}
        where ${usageLogs.apiKeyId} = ${command.apiKeyId}
          and ${usageLogs.status} = 0
          and ${usageLogs.createdAt} >= ${todayStart}
      `);
      const keyExposureRow = await tx.execute<{ total: string }>(sql`
        select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
        from ${billingRequests}
        where ${billingRequests.apiKeyId} = ${command.apiKeyId}
          and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','dead')
      `);
      const keyProjected = toDecimal(keySpentRow.rows[0]?.total ?? '0')
        .plus(toDecimal(keyExposureRow.rows[0]?.total ?? '0'))
        .plus(toDecimal(amount));
      if (keyProjected.gt(key.dailySpendLimit)) {
        throw new DailySpendLimitExceededError(
          command.userId,
          key.dailySpendLimit,
          keyProjected.toString(),
          'key',
          command.apiKeyId,
        );
      }
    }
  } else if (command.appId != null) {
    // JWT/App 凭证：读 apps.subscription_id（单一真相）。
    const app = await tx.query.apps.findFirst({
      where: eq(apps.id, command.appId),
      columns: { subscriptionId: true },
    });
    if (app) subscriptionId = app.subscriptionId;
  }
  return subscriptionId;
}
