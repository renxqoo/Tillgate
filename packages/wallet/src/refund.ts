/** refund：退款——余额守卫（balance ≥ amount），独立幂等域 (refType, refId, 'refund') */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { InsufficientBalanceError } from './errors';
import { walletAccounts, walletTransactions } from './schema';
import { lockAccount } from './account';
import { isUniqueViolation } from './internal';
import { replayMovement } from './replay';
import { parseAmount, parseUserRef } from './validation';
import type { CreditResult, RefundInput } from './types';

export async function refund(db: NodePgDatabase, input: RefundInput): Promise<CreditResult> {
  parseUserRef(input);
  const amount = parseAmount(input.amount);

  try {
    return await db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.userId);
      const balance = new Decimal(account.balance);
      if (balance.lt(amount)) {
        throw new InsufficientBalanceError(input.userId, toStorage(balance), toStorage(amount));
      }
      const balanceAfter = balance.minus(amount);
      const [row] = await tx
        .insert(walletTransactions)
        .values({
          userId: input.userId,
          kind: 'refund',
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount.neg()),
          balanceBefore: account.balance,
          balanceAfter: toStorage(balanceAfter),
          memo: input.memo,
        })
        .returning({ id: walletTransactions.id });
      if (!row) throw new Error('wallet refund insert failed');
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
    if (isUniqueViolation(error)) {
      return replayMovement(db, input.refType, input.refId, 'refund', input.userId);
    }
    throw error;
  }
}
