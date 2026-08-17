/** balance：余额查询（无户返回 '0'） */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { walletAccounts } from './schema';
import { userIdSchema } from './validation';
import { z } from 'zod';

export async function balance(db: NodePgDatabase, userId: number): Promise<string> {
  z.object({ userId: userIdSchema }).parse({ userId });
  const [row] = await db
    .select({ balance: walletAccounts.balance })
    .from(walletAccounts)
    .where(eq(walletAccounts.userId, userId));
  return row ? normalizeAmount(row.balance) : '0';
}
