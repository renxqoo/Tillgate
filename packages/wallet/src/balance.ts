/** balance / accounts：查询（无户返回 '0'；accounts 列出用户全部币种摘要） */
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { normalizeAmount } from './money';
import { walletAccounts } from './schema';
import { currencySchema, userIdSchema } from './validation';
import { DEFAULT_CURRENCY } from './types';
import type { AccountSummary } from './types';

export async function balance(
  db: NodePgDatabase,
  userId: number,
  currency: string = DEFAULT_CURRENCY,
): Promise<string> {
  z.object({ userId: userIdSchema }).parse({ userId });
  currencySchema.parse(currency);
  const [row] = await db
    .select({ balance: walletAccounts.balance })
    .from(walletAccounts)
    .where(and(eq(walletAccounts.userId, userId), eq(walletAccounts.currency, currency)));
  return row ? normalizeAmount(row.balance) : '0';
}

export async function accounts(db: NodePgDatabase, userId: number): Promise<AccountSummary[]> {
  z.object({ userId: userIdSchema }).parse({ userId });
  const rows = await db
    .select({
      currency: walletAccounts.currency,
      balance: walletAccounts.balance,
      inFlight: walletAccounts.inFlight,
      creditLimit: walletAccounts.creditLimit,
    })
    .from(walletAccounts)
    .where(eq(walletAccounts.userId, userId))
    .orderBy(asc(walletAccounts.currency));
  return rows.map((row) => ({
    currency: row.currency,
    balance: normalizeAmount(row.balance),
    inFlight: normalizeAmount(row.inFlight),
    creditLimit: normalizeAmount(row.creditLimit),
  }));
}
