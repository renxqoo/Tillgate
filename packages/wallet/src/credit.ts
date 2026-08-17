/** credit：入账（充值/赠送/返佣）——双腿 [本方 +a, 对手科目 −a]；幂等键同 v1 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { walletTransactions } from './schema';
import { lockAccounts, resolveInternalAccount, resolveUserAccount } from './account';
import { applyLeg } from './legs';
import { isUniqueViolation } from './internal';
import { replayLegged } from './replay';
import { parseAmount, parseUserRef } from './validation';
import { OUTSIDE_ACCOUNT } from './types';
import type { CreditInput, CreditResult } from './types';

export async function credit(db: NodePgDatabase, input: CreditInput): Promise<CreditResult> {
  const currency = parseUserRef(input);
  const amount = parseAmount(input.amount);
  const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;

  try {
    return await db.transaction(async (tx) => {
      const userAccountId = await resolveUserAccount(tx, input.userId, currency);
      const cpAccountId = await resolveInternalAccount(tx, counterparty, currency);
      const accounts = await lockAccounts(tx, [userAccountId, cpAccountId]);

      const [header] = await tx
        .insert(walletTransactions)
        .values({ kind: 'credit', refType: input.refType, refId: input.refId, memo: input.memo })
        .returning({ id: walletTransactions.id });
      if (!header) throw new Error('wallet credit insert failed');

      const userAfter = await applyLeg(
        tx, header.id, userAccountId, currency, amount, accounts.get(userAccountId)!.balance,
      );
      await applyLeg(
        tx, header.id, cpAccountId, currency, amount.neg(), accounts.get(cpAccountId)!.balance,
      );
      return {
        transactionId: header.id,
        amount: normalizeAmount(input.amount),
        balanceAfter: userAfter,
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayLegged(db, input.refType, input.refId, 'credit', input.userId, currency);
    }
    throw error;
  }
}
