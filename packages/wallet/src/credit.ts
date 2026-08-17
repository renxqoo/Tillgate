/** credit：入账（充值/赠送/返佣）——(refType, refId, 'credit') 幂等，并发重放读回首条 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { walletAccounts, walletTransactions } from './schema';
import { lockAccount } from './account';
import { isUniqueViolation } from './internal';
import { replayMovement } from './replay';
import { parseAmount, parseUserRef } from './validation';
import type { CreditInput, CreditResult } from './types';

export async function credit(db: NodePgDatabase, input: CreditInput): Promise<CreditResult> {
  parseUserRef(input);
  const amount = parseAmount(input.amount);

  try {
    return await db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.userId);
      const balanceAfter = new Decimal(account.balance).plus(amount);
      const [row] = await tx
        .insert(walletTransactions)
        .values({
          userId: input.userId,
          kind: 'credit',
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount),
          balanceBefore: account.balance,
          balanceAfter: toStorage(balanceAfter),
          memo: input.memo,
        })
        .returning({ id: walletTransactions.id });
      if (!row) throw new Error('wallet credit insert failed');
      await tx
        .update(walletAccounts)
        .set({ balance: toStorage(balanceAfter), updatedAt: new Date() })
        .where(eq(walletAccounts.userId, input.userId));
      return {
        transactionId: row.id,
        amount: normalizeAmount(input.amount),
        balanceAfter: toStorage(balanceAfter),
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return replayMovement(db, input.refType, input.refId, 'credit');
    throw error;
  }
}
