/** freeze：账户冻结/解冻（风控）——零额审计交易；冻结账户拒绝一切资金变动（查询不受限）；
 *  tx 注入加入调用方事务。 */
import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { walletAccounts } from './schema';
import { findAccountId, lockAccounts, resolveAccount, resolveInternalAccounts } from './account';
import { postTransaction } from './posting';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { hasTransaction, replayFreeze } from './replay';
import { assertBoolean, parseAccountRef, parseRef, type ValidationGuards } from './validation';
import { Decimal } from './money';
import type { FreezeInput, FreezeResult } from './types';
import { commandFingerprint } from './idempotency';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS } from './sharding';

export async function freeze(
  db: NodePgDatabase,
  input: FreezeInput,
  guards?: ValidationGuards,
): Promise<FreezeResult> {
  parseRef({ refType: input.refType, refId: input.refId }, guards);
  assertBoolean(input.frozen, 'frozen');
  const currency = parseAccountRef(input.target, guards);
  const fingerprint = commandFingerprint('freeze', {
    target: { userId: input.target.userId, code: input.target.code, currency },
    frozen: input.frozen,
    memo: input.memo ?? null,
  });
  const shardCount = guards?.internalAccountShards ?? DEFAULT_INTERNAL_ACCOUNT_SHARDS;
  const conn: DbLike = input.tx ?? db;

  if (await hasTransaction(conn, input.refType, input.refId, 'freeze')) {
    const accountId = await findAccountId(conn, input.target, currency);
    return replayFreeze(conn, input.refType, input.refId, accountId, fingerprint);
  }

  try {
    return await runTx(
      conn,
      async (tx) => {
        const accountIds =
          typeof input.target.userId === 'number'
            ? [await resolveAccount(tx, input.target, currency)]
            : await resolveInternalAccounts(tx, input.target.code!, currency, shardCount);
        const accounts = await lockAccounts(tx, accountIds, { allowFrozen: true });
        const accountId = accountIds[0]!;
        const posted = await postTransaction(
          tx,
          {
            kind: 'freeze',
            refType: input.refType,
            refId: input.refId,
            memo: input.memo ?? (input.frozen ? 'frozen' : 'unfrozen'),
            frozenAfter: input.frozen,
            commandFingerprint: fingerprint,
            legs: [{ accountId, currency, amount: new Decimal(0) }],
          },
          accounts,
        );
        await tx
          .update(walletAccounts)
          .set({ status: input.frozen ? 'frozen' : 'active', updatedAt: new Date() })
          .where(inArray(walletAccounts.id, accountIds));
        return {
          transactionId: posted.transactionId,
          frozen: input.frozen,
          replayed: false,
        };
      },
      guards?.telemetry,
      'freeze',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const accountId = await findAccountId(conn, input.target, currency);
      return replayFreeze(conn, input.refType, input.refId, accountId, fingerprint);
    }
    throw error;
  }
}
