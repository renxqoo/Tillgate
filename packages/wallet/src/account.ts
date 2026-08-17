/** 账户行锁：所有资金变动的串行化点（先建户再 FOR UPDATE） */
import { eq } from 'drizzle-orm';
import { walletAccounts } from './schema';
import type { Tx } from './internal';

/** 建户（无则插入）+ 行锁；返回锁定的账户行 */
export async function lockAccount(
  tx: Tx,
  userId: number,
): Promise<{ balance: string; inFlight: string }> {
  await tx.insert(walletAccounts).values({ userId }).onConflictDoNothing();
  const [row] = await tx
    .select({ balance: walletAccounts.balance, inFlight: walletAccounts.inFlight })
    .from(walletAccounts)
    .where(eq(walletAccounts.userId, userId))
    .for('update');
  if (!row) throw new Error('wallet account lock failed');
  return row;
}
