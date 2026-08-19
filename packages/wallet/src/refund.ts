/** refund：退款——双腿 [本方 −a, 收入科目冲回 −a]；授信地板守卫；独立幂等域；
 *  tx 注入加入调用方事务。 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { lockAccounts, resolveInternalAccount, resolveUserAccount } from './account';
import { postTransaction } from './posting';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { hasTransaction, replayLegged } from './replay';
import { parseAmount, parseCounterparty, parseUserRef, type ValidationGuards } from './validation';
import { OUTSIDE_ACCOUNT } from './types';
import type { CreditResult, RefundInput } from './types';
import { assertCanDebit } from './exposure';
import { commandFingerprint } from './idempotency';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS, selectInternalShard } from './sharding';

export async function refund(
  db: NodePgDatabase,
  input: RefundInput,
  guards?: ValidationGuards,
): Promise<CreditResult> {
  const currency = parseUserRef(input, guards);
  const amount = parseAmount(input.amount);
  // 退款 = 钱离开用户余额回到对手科目（缺省原路退回外部；费用承担类退款可指定营销费用等科目）
  const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;
  parseCounterparty(counterparty, guards);
  const fingerprint = commandFingerprint('refund', {
    userId: input.userId,
    currency,
    amount: normalizeAmount(input.amount),
    counterparty,
    memo: input.memo ?? null,
  });
  const counterpartyShard = selectInternalShard(
    input.refType,
    input.refId,
    guards?.internalAccountShards ?? DEFAULT_INTERNAL_ACCOUNT_SHARDS,
  );
  const conn: DbLike = input.tx ?? db;

  // 幂等快速路径：守卫之前先查已存在（首笔可能已把余额花掉，重放不该再过守卫）
  if (await hasTransaction(conn, input.refType, input.refId, 'refund')) {
    return replayLegged(
      conn,
      input.refType,
      input.refId,
      'refund',
      input.userId,
      currency,
      fingerprint,
    );
  }

  try {
    return await runTx(
      conn,
      async (tx) => {
        const userAccountId = await resolveUserAccount(tx, input.userId, currency);
        const cpAccountId = await resolveInternalAccount(
          tx,
          counterparty,
          currency,
          counterpartyShard,
        );
        const accounts = await lockAccounts(tx, [userAccountId, cpAccountId]);

        const user = accounts.get(userAccountId)!;
        assertCanDebit(user, amount, input.userId);

        const posted = await postTransaction(
          tx,
          {
            kind: 'refund',
            refType: input.refType,
            refId: input.refId,
            memo: input.memo,
            commandFingerprint: fingerprint,
            legs: [
              { accountId: userAccountId, currency, amount: amount.neg() },
              { accountId: cpAccountId, currency, amount },
            ],
          },
          accounts,
        );
        return {
          transactionId: posted.transactionId,
          amount: normalizeAmount(input.amount),
          balanceAfter: posted.balanceAfter.get(userAccountId)!,
          replayed: false,
        };
      },
      guards?.telemetry,
      'refund',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayLegged(
        conn,
        input.refType,
        input.refId,
        'refund',
        input.userId,
        currency,
        fingerprint,
      );
    }
    throw error;
  }
}
