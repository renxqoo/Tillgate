import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  users,
  usageLogs,
  transactions,
  userSubscriptions,
  reconcileDiscrepancies,
} from '@ai-gateway/db/schema';
import { Decimal, toDecimal } from '@ai-gateway/money';

/**
 * 对账作业（金融级护栏）。
 *
 * 独立于主计费链路：不阻塞计费，只校验账本一致性 + 留痕告警。
 * 定期（如每小时）由 worker 调用，发现资损/漏扣/重复扣。
 *
 * 用户级校验（核心）：
 *   理论余额变动 = sum(收入类流水) - sum(支出类流水)
 *   实际余额 = users.balance
 *   二者应一致（容差 1e-9 元，吸收 numeric 极小尾差）
 *
 * 不平 → 写 reconcile_discrepancies 表（留痕）+ 返回差异数（调用方告警）。
 */

/** 非 consume 类流水（余额变动，签名正负皆可；reconcile 只求和，分桶只为穷尽覆盖） */
const INCOME_TYPES = ['redeem', 'gift', 'manual', 'refund', 'subscribe', 'pack'] as const;
/** 支出类流水类型（amount < 0） */
const EXPENSE_TYPES = ['consume'] as const;

export interface ReconcileResult {
  checkedUsers: number;
  /** 渠道在途敞口校验覆盖的渠道数（R4：接入渠道维度对账） */
  checkedChannels?: number;
  discrepancies: number;
}

/**
 * 对账单个用户：已结算余额与资金流水一致；在途敞口与活跃请求一致。
 *
 * 信用模型：authorize 只记在途敞口、不修改 users.balance，余额可为负（≥ -credit_limit）；
 * users.reserved_balance 必须等于所有未终结 billing_requests.reserved_amount 之和。
 *
 * @returns true = 一致
 */
export async function reconcileUser(db: Db, userId: number): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true, reservedBalance: true },
  });
  if (!user) return true;
  const actual = new Decimal(user.balance);

  // 理论余额变动 = sum(收入) + sum(支出)（支出 amount 已为负）
  // 注意：IN 列表必须用 inArray（sql 模板插值会把整个列表转义成单个字符串参数，查询永远空）
  const incomeRow = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}),0)::numeric` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.type, [...INCOME_TYPES])));
  const expenseRow = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}),0)::numeric` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.type, [...EXPENSE_TYPES])));
  const expected = new Decimal(incomeRow[0]?.total ?? '0').plus(
    new Decimal(expenseRow[0]?.total ?? '0'),
  );

  // 活跃请求汇总必须与用户行上的事务型预留计数一致。
  // 信用模型 + 套餐分流：users.reserved_balance 只承载 payg 部分；
  // billing_requests.reserved_amount 是总额，减去 plan_reserved_amount 才是余额在途。
  const heldRow = await db
    .select({
      total: sql<string>`coalesce(sum(${billingRequests.reservedAmount} - coalesce(${billingRequests.planReservedAmount}, 0)), 0)::numeric`,
    })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.userId, userId),
        inArray(billingRequests.status, [
          'authorized',
          'in_flight',
          'settlement_pending',
          'processing',
          'retry_wait',
          'uncertain',
          'dead',
        ]),
      ),
    );
  const expectedReserved = new Decimal(heldRow[0]?.total ?? '0');
  const actualReserved = new Decimal(user.reservedBalance);

  // 容差 1e-9 元（吸收 numeric 极小尾差）
  const balanceDiff = actual.minus(expected);
  const reservationDiff = actualReserved.minus(expectedReserved);
  if (
    balanceDiff.abs().lte(new Decimal('0.000000001')) &&
    reservationDiff.abs().lte(new Decimal('0.000000001'))
  )
    return true;

  // 不平：留痕
  await db.insert(reconcileDiscrepancies).values({
    scope: 'user',
    userId,
    expected: expected.toString(),
    actual: actual.toString(),
    diff: balanceDiff.abs().gt(reservationDiff.abs())
      ? balanceDiff.toString()
      : reservationDiff.toString(),
    detail: `资金对账不平：已结算余额理论 ${expected.toString()} 实际 ${actual.toString()}；处理中预留理论 ${expectedReserved.toString()} 实际 ${actualReserved.toString()}`,
  });
  return false;
}

/**
 * 全量对账：扫描近期有交易的用户，逐个校验。
 * @param recentDays 只查最近 N 天有交易的用户（避免全表扫描）
 */
export async function reconcileAll(db: Db, recentDays = 7): Promise<ReconcileResult> {
  const recentUsers = await db.execute<{ user_id: number }>(sql`
    select user_id from transactions
      where created_at >= now() - (${recentDays}::text || ' days')::interval
    union
    select user_id from billing_requests
      where created_at >= now() - (${recentDays}::text || ' days')::interval
  `);
  let discrepancies = 0;
  for (const row of recentUsers.rows) {
    const userId = Number(row.user_id);
    const [balanceOk, usageOk, subscriptionOk] = await Promise.all([
      reconcileUser(db, userId),
      reconcileUsageVsTransactions(db, userId),
      reconcileSubscriptionReserved(db, userId),
    ]);
    if (!balanceOk) discrepancies += 1;
    if (!usageOk) discrepancies += 1;
    if (!subscriptionOk) discrepancies += 1;
  }
  const channelsResult = await reconcileChannels(db, recentDays);
  return {
    checkedUsers: recentUsers.rows.length,
    checkedChannels: channelsResult.checkedChannels,
    discrepancies: discrepancies + channelsResult.discrepancies,
  };
}

/**
 * 渠道维度批量对账（R4 接线）：覆盖「近 N 天有账单」或「当前在途敞口非 0」的渠道。
 * 此前 reconcileChannelReserved 从未被调度，渠道敞口泄漏只能靠人工发现。
 */
export async function reconcileChannels(
  db: Db,
  recentDays = 7,
): Promise<{ checkedChannels: number; discrepancies: number }> {
  const candidates = await db.execute<{ channel_id: number }>(sql`
    select distinct channel_id from billing_requests
      where channel_id is not null
        and created_at >= now() - (${recentDays}::text || ' days')::interval
    union
    select id as channel_id from channels where upstream_reserved <> 0
  `);
  let discrepancies = 0;
  for (const row of candidates.rows) {
    const ok = await reconcileChannelReserved(db, Number(row.channel_id));
    if (!ok) discrepancies += 1;
  }
  return { checkedChannels: candidates.rows.length, discrepancies };
}

/**
 * 用量金额一致性校验（辅助）：
 *   - 余额部分：sum(usage_logs.payg_amount) 应等于 sum(consume 流水 amount 的绝对值)
 *   - 套餐部分：sum(usage_logs.plan_amount) 应等于 sum(user_subscriptions.used_amount)
 * 用于发现 usage_logs 与 transactions / 订阅账本脱节的场景。
 */
export async function reconcileUsageVsTransactions(db: Db, userId: number): Promise<boolean> {
  const paygSum = await db
    .select({ total: sql<string>`coalesce(sum(${usageLogs.paygAmount}),0)::numeric` })
    .from(usageLogs)
    .where(eq(usageLogs.userId, userId));
  const planSum = await db
    .select({ total: sql<string>`coalesce(sum(${usageLogs.planAmount}),0)::numeric` })
    .from(usageLogs)
    .where(eq(usageLogs.userId, userId));
  const consumeSum = await db
    .select({ total: sql<string>`coalesce(sum(abs(${transactions.amount})),0)::numeric` })
    .from(transactions)
    .where(sql`${transactions.userId} = ${userId} AND ${transactions.type} = 'consume'`);
  const subUsedSum = await db
    .select({ total: sql<string>`coalesce(sum(${userSubscriptions.usedAmount}),0)::numeric` })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId));

  const payg = new Decimal(paygSum[0]?.total ?? '0');
  const plan = new Decimal(planSum[0]?.total ?? '0');
  const consume = new Decimal(consumeSum[0]?.total ?? '0');
  const subUsed = new Decimal(subUsedSum[0]?.total ?? '0');

  const paygDiff = payg.minus(consume);
  const planDiff = plan.minus(subUsed);
  if (paygDiff.abs().lte(new Decimal('0.000000001')) && planDiff.abs().lte(new Decimal('0.000000001'))) {
    return true;
  }
  await db.insert(reconcileDiscrepancies).values({
    scope: 'user',
    userId,
    expected: consume.plus(subUsed).toString(),
    actual: payg.plus(plan).toString(),
    diff: paygDiff.abs().gt(planDiff.abs()) ? paygDiff.toString() : planDiff.toString(),
    detail: `用量-流水对账不平：payg ${payg.toString()} vs consume ${consume.toString()}；plan ${plan.toString()} vs subscription_used ${subUsed.toString()}`,
  });
  return false;
}

/**
 * 订阅在途敞口一致性校验：user_subscriptions.reserved_amount 必须等于
 * 该用户所有活跃 billing_requests.plan_reserved_amount 之和（容差 1e-9）。
 */
export async function reconcileSubscriptionReserved(db: Db, userId: number): Promise<boolean> {
  const subs = await db
    .select({ id: userSubscriptions.id, reservedAmount: userSubscriptions.reservedAmount })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId));
  const reservedActual = subs.reduce(
    (acc, s) => acc.plus(toDecimal(s.reservedAmount)),
    new Decimal(0),
  );
  const activeSum = await db
    .select({
      total: sql<string>`coalesce(sum(${billingRequests.planReservedAmount}),0)::numeric`,
    })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.userId, userId),
        inArray(billingRequests.status, [
          'authorized',
          'in_flight',
          'settlement_pending',
          'processing',
          'retry_wait',
          'uncertain',
          'dead',
        ]),
      ),
    );
  const reservedExpected = new Decimal(activeSum[0]?.total ?? '0');
  const diff = reservedActual.minus(reservedExpected);
  if (diff.abs().lte(new Decimal('0.000000001'))) return true;
  await db.insert(reconcileDiscrepancies).values({
    scope: 'user',
    userId,
    expected: reservedExpected.toString(),
    actual: reservedActual.toString(),
    diff: diff.toString(),
    detail: `订阅在途敞口不平（user=${userId}）：user_subscriptions.reserved ${reservedActual.toString()} vs 活跃请求 plan_reserved 和 ${reservedExpected.toString()}`,
  });
  return false;
}

/**
 * 渠道级在途敞口一致性校验：channels.upstream_reserved 必须等于
 * 该渠道所有活跃 billing_requests.channel_reserved_amount 之和（容差 1e-9）。
 * 用于发现 reserve/release 脱节（资损护栏自身的正确性）。
 */
export async function reconcileChannelReserved(db: Db, channelId: number): Promise<boolean> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { upstreamReserved: true },
  });
  if (!channel) return true;
  const activeSum = await db
    .select({
      total: sql<string>`coalesce(sum(${billingRequests.channelReservedAmount}),0)::numeric`,
    })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.channelId, channelId),
        inArray(billingRequests.status, [
          // dead 仍持有渠道敞口直到 abandonDead，属合法在途，缺失会造成假差异
          'authorized',
          'in_flight',
          'settlement_pending',
          'processing',
          'retry_wait',
          'uncertain',
          'dead',
        ]),
      ),
    );
  const expected = new Decimal(activeSum[0]?.total ?? '0');
  const actual = new Decimal(channel.upstreamReserved);
  const diff = actual.minus(expected);
  if (diff.abs().lte(new Decimal('0.000000001'))) return true;
  await db.insert(reconcileDiscrepancies).values({
    scope: 'channel',
    userId: null,
    expected: expected.toString(),
    actual: actual.toString(),
    diff: diff.toString(),
    detail: `渠道在途敞口不平（channel=${channelId}）：channels.upstream_reserved ${actual.toString()} vs 活跃请求敞口和 ${expected.toString()}`,
  });
  return false;
}
