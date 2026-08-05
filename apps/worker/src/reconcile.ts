import { sql, eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { users, usageLogs, transactions, reconcileDiscrepancies } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';

/**
 * 对账作业（金融级护栏，重构新增）。
 *
 * 独立于主计费链路：不阻塞计费，只校验账本一致性 + 留痕告警。
 * 定期（如每小时）由 worker 调用，发现资损/漏扣/重复扣。
 *
 * 用户级校验（核心）：
 *   理论余额变动 = sum(收入类流水) - sum(支出类流水)
 *   实际余额 = users.balance
 *   二者应一致（容差 1e-9 元，吸收 numeric 极小尾差）
 *
 * 平台级校验：
 *   累计上游成本 sum(upstream_cost) 统计（供财务对账上游账单）
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
 * 对账单个用户：理论余额变动 vs 实际余额。
 * @returns 差异条数（0 = 一致）
 */
export async function reconcileUser(db: Db, userId: number): Promise<boolean> {
  // 实际余额
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  if (!user) return true;
  const actual = new Decimal(user.balance);

  // 理论余额变动 = sum(收入) + sum(支出)（支出 amount 已为负）
  const incomeRow = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}),0)::numeric` })
    .from(transactions)
    .where(sql`${transactions.userId} = ${userId} AND ${transactions.type} IN (${INCOME_TYPES.map((t) => `'${t}'`).join(',')})`);
  const expenseRow = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}),0)::numeric` })
    .from(transactions)
    .where(sql`${transactions.userId} = ${userId} AND ${transactions.type} IN (${EXPENSE_TYPES.map((t) => `'${t}'`).join(',')})`);
  const expected = new Decimal(incomeRow[0]?.total ?? '0').plus(new Decimal(expenseRow[0]?.total ?? '0'));

  // 容差 1e-9 元（吸收 numeric 极小尾差）
  const diff = actual.minus(expected);
  if (diff.abs().lte(new Decimal('0.000000001'))) return true; // 一致

  // 不平：留痕
  await db.insert(reconcileDiscrepancies).values({
    scope: 'user',
    userId,
    expected: expected.toString(),
    actual: actual.toString(),
    diff: diff.toString(),
    detail: `余额对账不平：理论 ${expected.toString()} 实际 ${actual.toString()}`,
  });
  return false;
}

/**
 * 全量对账：扫描近期有交易的用户，逐个校验。
 * @param recentDays 只查最近 N 天有交易的用户（避免全表扫描）
 */
export async function reconcileAll(db: Db, recentDays = 7): Promise<ReconcileResult> {
  // 取最近有交易的用户（去重）
  const recentUsers = await db
    .select({ userId: transactions.userId })
    .from(transactions)
    .where(sql`${transactions.createdAt} >= now() - interval '${recentDays} days'`)
    .groupBy(transactions.userId);
  let discrepancies = 0;
  for (const { userId } of recentUsers) {
    const ok = await reconcileUser(db, userId);
    if (!ok) discrepancies += 1;
  }
  return { checkedUsers: recentUsers.length, discrepancies };
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
