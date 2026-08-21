/** settle：实扣落定——CAS active→settled + 双腿 [持有人 −a, 收入科目 +a]（结算即收入确认）；
 *  可少于冻结额（余量即归还）；重放返回首次结果；tx 注入加入调用方事务
 *  （补充授权结算：authorize#over + settle#over + settle 原单同事务）。 */
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  SettleExceedsHoldError,
  WalletInternalError,
} from './errors';
import { walletAccounts, walletAuthorizations, walletLegs, walletTransactions } from './schema';
import { lockAccounts, resolveInternalAccount } from './account';
import { postTransaction } from './posting';
import { findAuthorization, lockAuthorization } from './authorizations';
import { parseAmount, parseCounterparty, parseRef, type ValidationGuards } from './validation';
import { REVENUE_ACCOUNT } from './types';
import type { SettleInput, SettleResult } from './types';
import { runTx, type DbLike, type Tx } from './internal';
import { assertCommandFingerprint, commandFingerprint } from './idempotency';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS, selectInternalShard } from './sharding';

export async function settle(
  db: NodePgDatabase,
  input: SettleInput,
  guards?: ValidationGuards,
): Promise<SettleResult> {
  parseRef(input, guards);
  const settleAmount = parseAmount(input.amount);
  const counterparty = input.counterparty ?? REVENUE_ACCOUNT;
  parseCounterparty(counterparty, guards);
  const fingerprint = commandFingerprint('settle', {
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

  return runTx(
    conn,
    async (tx) => {
      // 先锁定再做领域校验；避免 DB 状态约束把超额结算泄漏成原始 23514。
      const current = await lockAuthorization(tx, input.refType, input.refId);
      if (!current) throw new AuthorizationNotFoundError(input.refType, input.refId);
      if (current.status !== 'active') {
        return replaySettle(tx, input.refType, input.refId, fingerprint);
      }
      if (current.expiresAt) {
        const clock = await tx.execute(sql`select now() as now`);
        const databaseNow = new Date(String(clock.rows[0]?.now));
        if (current.expiresAt <= databaseNow) {
          throw new AuthorizationNotActiveError(input.refType, input.refId, 'expired');
        }
      }
      const held = new Decimal(current.amount);
      if (settleAmount.gt(held)) {
        throw new SettleExceedsHoldError(toStorage(held), input.amount);
      }
      const claimed = await tx
        .update(walletAuthorizations)
        .set({
          status: 'settled',
          settledAmount: toStorage(settleAmount),
          updatedAt: new Date(),
        })
        .where(
          and(eq(walletAuthorizations.id, current.id), eq(walletAuthorizations.status, 'active')),
        )
        .returning({
          id: walletAuthorizations.id,
          accountId: walletAuthorizations.accountId,
          amount: walletAuthorizations.amount,
        });
      if (claimed.length === 0) throw new WalletInternalError('settle.locked_cas_lost');
      const claim = claimed[0];
      if (!claim) throw new WalletInternalError('settle.cas_empty');
      const [holderIdentity] = await tx
        .select({ currency: walletAccounts.currency })
        .from(walletAccounts)
        .where(eq(walletAccounts.id, claim.accountId));
      if (!holderIdentity) throw new WalletInternalError('settle.holder_missing');
      const cpAccountId = await resolveInternalAccount(
        tx,
        counterparty,
        holderIdentity.currency,
        counterpartyShard,
      );
      const accounts = await lockAccounts(tx, [claim.accountId, cpAccountId]);
      const holder = accounts.get(claim.accountId)!;

      const posted = await postTransaction(
        tx,
        {
          kind: 'settle',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
          commandFingerprint: fingerprint,
          legs: [
            { accountId: claim.accountId, currency: holder.currency, amount: settleAmount.neg() },
            { accountId: cpAccountId, currency: holder.currency, amount: settleAmount },
          ],
        },
        accounts,
      );
      // 在途全额归还（余量随结算释放）
      await tx
        .update(walletAccounts)
        .set({
          inFlight: toStorage(new Decimal(holder.inFlight).minus(held)),
          updatedAt: new Date(),
        })
        .where(eq(walletAccounts.id, claim.accountId));
      return {
        authorizationId: claim.id,
        settledAmount: normalizeAmount(input.amount),
        balanceAfter: posted.balanceAfter.get(claim.accountId)!,
        releasedRemainder: toStorage(held.minus(settleAmount)),
        replayed: false,
      };
    },
    guards?.telemetry,
    'settle',
  );
}

/** CAS 失败分支：settled → 重放首次结果；released/expired → 状态机拒绝 */
async function replaySettle(
  tx: Tx,
  refType: string,
  refId: string,
  expectedFingerprint: string,
): Promise<SettleResult> {
  const auth = await findAuthorization(tx, refType, refId);
  if (!auth) throw new AuthorizationNotFoundError(refType, refId);
  if (auth.status === 'settled') {
    const [receipt] = await tx
      .select({
        balanceAfter: walletLegs.balanceAfter,
        commandFingerprint: walletTransactions.commandFingerprint,
      })
      .from(walletTransactions)
      .innerJoin(walletLegs, eq(walletLegs.transactionId, walletTransactions.id))
      .where(
        and(
          eq(walletTransactions.refType, refType),
          eq(walletTransactions.refId, refId),
          eq(walletTransactions.kind, 'settle'),
          eq(walletLegs.accountId, auth.accountId),
        ),
      );
    if (!receipt) throw new WalletInternalError('settle.replay_receipt_missing');
    assertCommandFingerprint(
      receipt.commandFingerprint,
      expectedFingerprint,
      refType,
      refId,
      'settle',
    );
    return {
      authorizationId: auth.id,
      settledAmount: normalizeAmount(auth.settledAmount ?? '0'),
      balanceAfter: normalizeAmount(receipt.balanceAfter),
      releasedRemainder: normalizeAmount(
        new Decimal(auth.amount).minus(auth.settledAmount ?? '0').toString(),
      ),
      replayed: true,
    };
  }
  throw new AuthorizationNotActiveError(refType, refId, auth.status);
}
