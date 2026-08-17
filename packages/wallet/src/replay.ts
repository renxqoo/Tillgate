/** 幂等重放：并发同键被唯一索引拦下后，读回首条动作流水作为结果 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { walletTransactions } from './schema';
import type { CreditResult } from './types';

export async function replayMovement(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  kind: 'credit' | 'refund',
): Promise<CreditResult> {
  const [row] = await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.refType, refType),
        eq(walletTransactions.refId, refId),
        eq(walletTransactions.kind, kind),
      ),
    );
  if (!row) throw new Error(`unique violation but no ${kind} row for ${refType}/${refId}`);
  return {
    transactionId: row.id,
    amount: normalizeAmount(row.amount.replace('-', '')),
    balanceAfter: normalizeAmount(row.balanceAfter),
    replayed: true,
  };
}
