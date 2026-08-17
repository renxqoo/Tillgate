/** 幂等重放：并发同键被唯一索引拦下后，读回首条动作流水作为结果（含归属校验） */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { RefKeyConflictError } from './errors';
import { walletTransactions } from './schema';
import type { CreditLineResult, CreditResult } from './types';

export async function replayMovement(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  kind: 'credit' | 'refund',
  ownership: { userId: number; currency: string },
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
  // 幂等键归属校验：同键跨账户/跨币种顶撞 = 调用方键设计冲突，必须炸而不是串号
  if (row.userId !== ownership.userId || row.currency !== ownership.currency) {
    throw new RefKeyConflictError(refType, refId, row.userId);
  }
  return {
    transactionId: row.id,
    amount: normalizeAmount(row.amount.replace('-', '')),
    balanceAfter: normalizeAmount(row.balanceAfter),
    replayed: true,
  };
}

/** credit_line 重放：读回首次的授信结果 */
export async function replayCreditLine(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  ownership: { userId: number; currency: string },
): Promise<CreditLineResult> {
  const [row] = await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.refType, refType),
        eq(walletTransactions.refId, refId),
        eq(walletTransactions.kind, 'credit_line'),
      ),
    );
  if (!row) throw new Error(`unique violation but no credit_line row for ${refType}/${refId}`);
  if (row.userId !== ownership.userId || row.currency !== ownership.currency) {
    throw new RefKeyConflictError(refType, refId, row.userId);
  }
  return {
    transactionId: row.id,
    creditLimit: normalizeAmount(row.creditLimitAfter ?? '0'),
    replayed: true,
  };
}
