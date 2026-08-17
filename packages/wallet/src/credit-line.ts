/** setCreditLimit：授信地板调整——零额审计交易（单腿 amount=0），幂等；
 *  守卫：新额度不得低于当前欠款（balance ≥ −newLimit）。 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { CreditLimitConflictError, WalletInternalError } from './errors';
import { walletAccounts, walletTransactions } from './schema';
import { lockAccounts, resolveUserAccount } from './account';
import { applyLeg } from './legs';
import { isUniqueViolation, runTx } from './internal';
import { replayCreditLine } from './replay';
import { parseNonNegativeAmount, parseUserRef, type ValidationGuards } from './validation';
import type { CreditLineInput, CreditLineResult } from './types';

export async function setCreditLimit(
  db: NodePgDatabase,
  input: CreditLineInput,
  guards?: ValidationGuards,
): Promise<CreditLineResult> {
  const currency = parseUserRef(input, guards);
  const newLimit = parseNonNegativeAmount(input.amount);

  try {
    return await runTx(db, async (tx) => {
      const accountId = await resolveUserAccount(tx, input.userId, currency);
      const accounts = await lockAccounts(tx, [accountId]);
      const account = accounts.get(accountId)!;
      const balance = new Decimal(account.balance);
      if (balance.lt(newLimit.neg())) {
        throw new CreditLimitConflictError(
          input.userId,
          currency,
          account.balance,
          toStorage(newLimit),
        );
      }
      const [header] = await tx
        .insert(walletTransactions)
        .values({
          kind: 'credit_line',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
          creditLimitAfter: toStorage(newLimit),
        })
        .returning({ id: walletTransactions.id });
      if (!header) throw new WalletInternalError('credit_line.insert');
      await applyLeg(tx, header.id, accountId, currency, new Decimal(0), account.balance);
      await tx
        .update(walletAccounts)
        .set({ creditLimit: toStorage(newLimit), updatedAt: new Date() })
        .where(eq(walletAccounts.id, accountId));
      return {
        transactionId: header.id,
        creditLimit: normalizeAmount(input.amount),
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayCreditLine(db, input.refType, input.refId, input.userId, currency);
    }
    throw error;
  }
}
