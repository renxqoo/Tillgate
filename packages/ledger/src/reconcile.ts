import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  billingRequests,
  users,
  usageLogs,
  transactions,
  reconcileDiscrepancies,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';

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

/** 收入类流水类型（amount > 0） */
const INCOME_TYPES = ['redeem', 'gift', 'manual', 'refund', 'subscribe'] as const;
/** 支出类流水类型（amount < 0） */
const EXPENSE_TYPES = ['consume'] as const;

export interface ReconcileResult {
  checkedUsers: number;
  discrepancies: number;
}

/**
 * 对账单个用户：已结算余额与资金流水一致；预留汇总与活跃请求一致。
 *
 * 授权不修改 users.balance，因此余额直接等于流水净额；users.reserved_balance
 * 必须等于所有未终结 billing_requests.reserved_amount 之和。
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
  const heldRow = await db
    .select({ total: sql<string>`coalesce(sum(${billingRequests.reservedAmount}),0)::numeric` })
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
    const [balanceOk, usageOk] = await Promise.all([
      reconcileUser(db, userId),
      reconcileUsageVsTransactions(db, userId),
    ]);
    if (!balanceOk) discrepancies += 1;
    if (!usageOk) discrepancies += 1;
  }
  return { checkedUsers: recentUsers.rows.length, discrepancies };
}

/**
 * 用量金额一致性校验（辅助）：sum(usage_logs.amount) 应等于 sum(consume 流水 amount 的绝对值)。
 * 用于发现 usage_logs 与 transactions 脱节的场景。
 */
export async function reconcileUsageVsTransactions(db: Db, userId: number): Promise<boolean> {
  const usageSum = await db
    .select({ total: sql<string>`coalesce(sum(${usageLogs.amount}),0)::numeric` })
    .from(usageLogs)
    .where(eq(usageLogs.userId, userId));
  const consumeSum = await db
    .select({ total: sql<string>`coalesce(sum(abs(${transactions.amount})),0)::numeric` })
    .from(transactions)
    .where(sql`${transactions.userId} = ${userId} AND ${transactions.type} = 'consume'`);
  const usage = new Decimal(usageSum[0]?.total ?? '0');
  const consume = new Decimal(consumeSum[0]?.total ?? '0');
  const diff = usage.minus(consume);
  if (diff.abs().lte(new Decimal('0.000000001'))) return true;
  await db.insert(reconcileDiscrepancies).values({
    scope: 'user',
    userId,
    expected: consume.toString(),
    actual: usage.toString(),
    diff: diff.toString(),
    detail: `用量-流水对账不平：usage_logs ${usage.toString()} vs consume ${consume.toString()}`,
  });
  return false;
}
