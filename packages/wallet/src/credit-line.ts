/** setCreditLimit：授信地板调整——不动余额（零额审计流水），幂等键同其他动词；
 *  守卫：新额度不得低于当前欠款（balance ≥ −newLimit），否则击穿地板拒绝 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { CreditLimitConflictError } from './errors';
import { walletAccounts, walletTransactions } from './schema';
import { lockAccount } from './account';
import { isUniqueViolation } from './internal';
import { replayCreditLine } from './replay';
import { parseNonNegativeAmount, parseUserRef } from './validation';
import type { CreditLineInput, CreditLineResult } from './types';

export async function setCreditLimit(
  db: NodePgDatabase,
  input: CreditLineInput,
): Promise<CreditLineResult> {
  const currency = parseUserRef(input);
  const newLimit = parseNonNegativeAmount(input.amount);

  try {
    return await db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.userId, currency);
      const balance = new Decimal(account.balance);
      if (balance.lt(newLimit.neg())) {
        throw new CreditLimitConflictError(
          input.userId,
          currency,
          account.balance,
          toStorage(newLimit),
        );
      }
      const [row] = await tx
        .insert(walletTransactions)
        .values({
          userId: input.userId,
          currency,
          kind: 'credit_line',
          refType: input.refType,
          refId: input.refId,
          amount: '0',
          balanceBefore: account.balance,
          balanceAfter: account.balance,
          creditLimitAfter: toStorage(newLimit),
          memo: input.memo,
        })
        .returning({ id: walletTransactions.id });
      if (!row) throw new Error('wallet credit_line insert failed');
      await tx
        .update(walletAccounts)
        .set({ creditLimit: toStorage(newLimit), updatedAt: new Date() })
        .where(
          and(eq(walletAccounts.userId, input.userId), eq(walletAccounts.currency, currency)),
        );
      return {
        transactionId: row.id,
        creditLimit: normalizeAmount(input.amount),
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayCreditLine(db, input.refType, input.refId, {
        userId: input.userId,
        currency,
      });
    }
    throw error;
  }
}
