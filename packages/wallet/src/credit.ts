/** credit：入账（充值/赠送/返佣）——双腿 [本方 +a, 对手科目 −a]；幂等键 (ref_type, ref_id)；
 *  tx 注入加入调用方事务。 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { lockAccounts, resolveInternalAccount, resolveUserAccount } from './account';
import { postTransaction } from './posting';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { hasTransaction, replayLegged } from './replay';
import { parseAmount, parseCounterparty, parseUserRef, type ValidationGuards } from './validation';
import { OUTSIDE_ACCOUNT } from './types';
import type { CreditInput, CreditResult } from './types';
import { commandFingerprint } from './idempotency';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS, selectInternalShard } from './sharding';

export async function credit(
  db: NodePgDatabase,
  input: CreditInput,
  guards?: ValidationGuards,
): Promise<CreditResult> {
  const currency = parseUserRef(input, guards);
  const amount = parseAmount(input.amount);
  const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;
  parseCounterparty(counterparty, guards);
  const fingerprint = commandFingerprint('credit', {
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

  if (await hasTransaction(conn, input.refType, input.refId, 'credit')) {
    return replayLegged(
      conn,
      input.refType,
      input.refId,
      'credit',
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

        const posted = await postTransaction(
          tx,
          {
            kind: 'credit',
            refType: input.refType,
            refId: input.refId,
            memo: input.memo,
            commandFingerprint: fingerprint,
            legs: [
              { accountId: userAccountId, currency, amount },
              { accountId: cpAccountId, currency, amount: amount.neg() },
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
      'credit',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayLegged(
        conn,
        input.refType,
        input.refId,
        'credit',
        input.userId,
        currency,
        fingerprint,
      );
    }
    throw error;
  }
}
