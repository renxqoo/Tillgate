/** statement：流水查询（账单页/客服查账/对账导出的数据面）。
 *  游标分页（transactionId 降序， newest-first）；只读零副作用；
 *  返回本方腿（有符号金额 + 落账后余额）与同交易对手腿的账户信息。 */
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { normalizeAmount } from './money';
import { walletAccounts, walletLegs, walletTransactions } from './schema';
import { currencySchema, userIdSchema } from './validation';
import { DEFAULT_CURRENCY } from './types';
import type { StatementInput, StatementItem, StatementResult } from './types';

const KINDS = ['credit', 'settle', 'refund', 'transfer', 'credit_line', 'freeze'] as const;
const kindSchema = z.enum(KINDS);

export async function statement(
  db: NodePgDatabase,
  input: StatementInput,
): Promise<StatementResult> {
  const parsed = z
    .object({
      userId: userIdSchema,
      currency: currencySchema.optional(),
      kinds: z.array(kindSchema).min(1).optional(),
      /** 游标：返回 transactionId 严格小于它的记录（首页不传） */
      before: z.number().int().positive().optional(),
      /** 页大小 1–100，缺省 20 */
      limit: z.number().int().min(1).max(100).default(20),
    })
    .parse(input);
  const currency = parsed.currency ?? DEFAULT_CURRENCY;

  // 定位用户账户（只读：无户即空账单，不建户）
  const [account] = await db
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.kind, 'user'),
        eq(walletAccounts.userId, parsed.userId),
        eq(walletAccounts.currency, currency),
      ),
    );
  if (!account) return { items: [], nextCursor: null };

  const conditions = [eq(walletLegs.accountId, account.id)];
  if (parsed.before !== undefined) conditions.push(lt(walletLegs.transactionId, parsed.before));
  if (parsed.kinds) conditions.push(inArray(walletTransactions.kind, [...parsed.kinds]));

  const rows = await db
    .select({
      transactionId: walletLegs.transactionId,
      kind: walletTransactions.kind,
      refType: walletTransactions.refType,
      refId: walletTransactions.refId,
      amount: walletLegs.amount,
      balanceAfter: walletLegs.balanceAfter,
      memo: walletTransactions.memo,
      createdAt: walletTransactions.createdAt,
    })
    .from(walletLegs)
    .innerJoin(walletTransactions, eq(walletTransactions.id, walletLegs.transactionId))
    .where(and(...conditions))
    .orderBy(desc(walletLegs.transactionId))
    .limit(parsed.limit + 1); // 多取一条探测下一页

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;
  if (page.length === 0) return { items: [], nextCursor: null };

  // 批量取同交易全部腿 → 对手方账户信息（免 N+1）
  const txIds = page.map((row) => row.transactionId);
  const siblingLegs = await db
    .select({
      transactionId: walletLegs.transactionId,
      accountKind: walletAccounts.kind,
      userId: walletAccounts.userId,
      code: walletAccounts.code,
    })
    .from(walletLegs)
    .innerJoin(walletAccounts, eq(walletAccounts.id, walletLegs.accountId))
    .where(inArray(walletLegs.transactionId, txIds));

  const items: StatementItem[] = page.map((row) => ({
    transactionId: row.transactionId,
    kind: row.kind,
    refType: row.refType,
    refId: row.refId,
    currency,
    amount: normalizeAmount(row.amount),
    balanceAfter: normalizeAmount(row.balanceAfter),
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
    counterparties: siblingLegs
      .filter((leg) => leg.transactionId === row.transactionId && leg.accountKind !== null)
      .filter((leg) => !(leg.userId === parsed.userId && leg.code === null))
      .map((leg) => ({
        kind: leg.accountKind as 'user' | 'internal',
        userId: leg.userId,
        code: leg.code,
      })),
  }));

  return {
    items,
    nextCursor: hasMore ? page[page.length - 1]!.transactionId : null,
  };
}
