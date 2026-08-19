/** setCreditLimit：授信地板调整——零额审计交易（单腿 amount=0），幂等；
 *  守卫：新额度不得低于当前欠款（balance ≥ −newLimit）；tx 注入加入调用方事务。 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { walletAccounts } from './schema';
import { lockAccounts, resolveUserAccount } from './account';
import { postTransaction } from './posting';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { hasTransaction, replayCreditLine } from './replay';
import { parseNonNegativeAmount, parseUserRef, type ValidationGuards } from './validation';
import type { CreditLineInput, CreditLineResult } from './types';
import { assertCreditLimitCoversExposure } from './exposure';
import { commandFingerprint } from './idempotency';

export async function setCreditLimit(
  db: NodePgDatabase,
  input: CreditLineInput,
  guards?: ValidationGuards,
): Promise<CreditLineResult> {
  const currency = parseUserRef(input, guards);
  const newLimit = parseNonNegativeAmount(input.amount);
  const fingerprint = commandFingerprint('credit_line', {
    userId: input.userId,
    currency,
    amount: normalizeAmount(input.amount),
    memo: input.memo ?? null,
  });
  const conn: DbLike = input.tx ?? db;

  if (await hasTransaction(conn, input.refType, input.refId, 'credit_line')) {
    return replayCreditLine(
      conn,
      input.refType,
      input.refId,
      input.userId,
      currency,
      fingerprint,
    );
  }

  try {
    return await runTx(
      conn,
      async (tx) => {
        const accountId = await resolveUserAccount(tx, input.userId, currency);
        const accounts = await lockAccounts(tx, [accountId]);
        const account = accounts.get(accountId)!;
        assertCreditLimitCoversExposure(account, newLimit, input.userId);
        const posted = await postTransaction(
          tx,
          {
            kind: 'credit_line',
            refType: input.refType,
            refId: input.refId,
            memo: input.memo,
            creditLimitAfter: toStorage(newLimit),
            commandFingerprint: fingerprint,
            legs: [{ accountId, currency, amount: new Decimal(0) }],
          },
          accounts,
        );
        await tx
          .update(walletAccounts)
          .set({ creditLimit: toStorage(newLimit), updatedAt: new Date() })
          .where(eq(walletAccounts.id, accountId));
        return {
          transactionId: posted.transactionId,
          creditLimit: normalizeAmount(input.amount),
          replayed: false,
        };
      },
      guards?.telemetry,
      'setCreditLimit',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayCreditLine(
        conn,
        input.refType,
        input.refId,
        input.userId,
        currency,
        fingerprint,
      );
    }
    throw error;
  }
}
