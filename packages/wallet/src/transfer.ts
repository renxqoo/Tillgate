/** transfer：原子转账（分账/P2P/手续费）——双腿 [from −a, to +a] 守恒；
 *  from/to 可为用户账户或内部科目；同币种限定（换汇 = 两笔独立转账）；
 *  from 为用户账户时 allowCredit:false 走现金口径；tx 注入加入调用方事务。 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { CurrencyMismatchError } from './errors';
import { lockAccounts } from './account';
import { postTransaction } from './posting';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { hasTransaction, replayTransfer } from './replay';
import { parseAccountRef, parseAmount, parseRef, type ValidationGuards } from './validation';
import type { TransferInput, TransferResult } from './types';
import { commandFingerprint } from './idempotency';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS, selectInternalShard } from './sharding';
import {
  assertDistinctTransferSides,
  buildTransferPosting,
  resolveTransferSide,
} from './transfer-accounts';

export async function transfer(
  db: NodePgDatabase,
  input: TransferInput,
  guards?: ValidationGuards,
): Promise<TransferResult> {
  parseRef({ refType: input.refType, refId: input.refId }, guards);
  const amount = parseAmount(input.amount);
  const fromCurrency = parseAccountRef(input.from, guards);
  const toCurrency = parseAccountRef(input.to, guards);
  const fingerprint = commandFingerprint('transfer', {
    from: { userId: input.from.userId, code: input.from.code, currency: fromCurrency },
    to: { userId: input.to.userId, code: input.to.code, currency: toCurrency },
    amount: normalizeAmount(input.amount),
    // 只在显式 false 时进指纹（与 authorize 同理：缺省调用零漂移）
    allowCredit: input.allowCredit === false ? false : undefined,
    memo: input.memo ?? null,
  });
  assertDistinctTransferSides(input.from, fromCurrency, input.to, toCurrency);
  const shardCount = guards?.internalAccountShards ?? DEFAULT_INTERNAL_ACCOUNT_SHARDS;
  const preferredShard = selectInternalShard(input.refType, input.refId, shardCount);
  // tx 注入时所有读写走调用方事务
  const conn: DbLike = input.tx ?? db;

  // 幂等快速路径：守卫之前先查已存在（首笔可能已把余额转走，重放不该再过守卫）
  if (await hasTransaction(conn, input.refType, input.refId, 'transfer')) {
    return replayTransfer(
      conn,
      input.refType,
      input.refId,
      input.from,
      input.to,
      fromCurrency,
      toCurrency,
      fingerprint,
    );
  }

  try {
    return await runTx(
      conn,
      async (tx) => {
        const from = await resolveTransferSide(tx, input.from, fromCurrency, shardCount);
        const to = await resolveTransferSide(tx, input.to, toCurrency, shardCount);
        if (from.currency !== to.currency) {
          throw new CurrencyMismatchError(from.currency, to.currency);
        }
        const accounts = await lockAccounts(tx, [...from.accountIds, ...to.accountIds]);
        const transferPosting = buildTransferPosting(
          from,
          to,
          accounts,
          amount,
          preferredShard,
          input.from.userId ?? 0,
          input.allowCredit ?? true,
        );

        const posted = await postTransaction(
          tx,
          {
            kind: 'transfer',
            refType: input.refType,
            refId: input.refId,
            memo: input.memo,
            commandFingerprint: fingerprint,
            legs: transferPosting.legs,
          },
          accounts,
        );
        return {
          transactionId: posted.transactionId,
          amount: normalizeAmount(input.amount),
          fromBalanceAfter: transferPosting.fromBalanceAfter,
          toBalanceAfter: transferPosting.toBalanceAfter,
          replayed: false,
        };
      },
      guards?.telemetry,
      'transfer',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayTransfer(
        conn,
        input.refType,
        input.refId,
        input.from,
        input.to,
        fromCurrency,
        toCurrency,
        fingerprint,
      );
    }
    throw error;
  }
}
