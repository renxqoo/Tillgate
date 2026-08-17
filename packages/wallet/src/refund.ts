/** refund：退款——双腿 [本方 −a, 收入科目冲回 −a]；授信地板守卫；独立幂等域 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { InsufficientBalanceError } from './errors';
import { walletTransactions } from './schema';
import { lockAccounts, resolveInternalAccount, resolveUserAccount } from './account';
import { applyLeg } from './legs';
import { isUniqueViolation } from './internal';
import { hasTransaction, replayLegged } from './replay';
import { parseAmount, parseUserRef } from './validation';
import { OUTSIDE_ACCOUNT } from './types';
import type { CreditResult, RefundInput } from './types';

export async function refund(db: NodePgDatabase, input: RefundInput): Promise<CreditResult> {
  const currency = parseUserRef(input);
  const amount = parseAmount(input.amount);
  // 退款 = 钱离开用户余额回到对手科目（缺省原路退回外部；费用承担类退款可指定营销费用等科目）
  const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;

  // 幂等快速路径：守卫之前先查已存在（首笔可能已把余额花掉，重放不该再过守卫）
  if (await hasTransaction(db, input.refType, input.refId, 'refund')) {
    return replayLegged(db, input.refType, input.refId, 'refund', input.userId, currency);
  }

  try {
    return await db.transaction(async (tx) => {
      const userAccountId = await resolveUserAccount(tx, input.userId, currency);
      const cpAccountId = await resolveInternalAccount(tx, counterparty, currency);
      const accounts = await lockAccounts(tx, [userAccountId, cpAccountId]);

      const user = accounts.get(userAccountId)!;
      const balance = new Decimal(user.balance);
      const floor = new Decimal(user.creditLimit).neg();
      if (balance.minus(amount).lt(floor)) {
        throw new InsufficientBalanceError(
          input.userId,
          toStorage(balance.minus(floor)),
          toStorage(amount),
          currency,
        );
      }

      const [header] = await tx
        .insert(walletTransactions)
        .values({ kind: 'refund', refType: input.refType, refId: input.refId, memo: input.memo })
        .returning({ id: walletTransactions.id });
      if (!header) throw new Error('wallet refund insert failed');

      const userAfter = await applyLeg(
        tx, header.id, userAccountId, currency, amount.neg(), user.balance,
      );
      await applyLeg(
        tx, header.id, cpAccountId, currency, amount, accounts.get(cpAccountId)!.balance,
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
      return replayLegged(db, input.refType, input.refId, 'refund', input.userId, currency);
    }
    throw error;
  }
}
