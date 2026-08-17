/** settle：实扣落定——CAS active→settled（可少于冻结额，余量即归还）；重放返回首次结果。
 *  币种随冻结单走（claim 带回 currency），账户按 (user, currency) 定位。 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  SettleExceedsHoldError,
} from './errors';
import { walletAccounts, walletAuthorizations, walletTransactions } from './schema';
import { lockAccount } from './account';
import { findAuthorization } from './authorizations';
import { parseAmount, parseRef } from './validation';
import type { SettleInput, SettleResult } from './types';
import type { Tx } from './internal';

export async function settle(db: NodePgDatabase, input: SettleInput): Promise<SettleResult> {
  parseRef(input);
  const settleAmount = parseAmount(input.amount);

  return db.transaction(async (tx) => {
    // CAS：active → settled（0 行 = 他路已处理：settled 重放、released/expired 拒绝）
    const claimed = await tx
      .update(walletAuthorizations)
      .set({
        status: 'settled',
        settledAmount: toStorage(settleAmount),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletAuthorizations.refType, input.refType),
          eq(walletAuthorizations.refId, input.refId),
          eq(walletAuthorizations.status, 'active'),
        ),
      )
      .returning({
        id: walletAuthorizations.id,
        userId: walletAuthorizations.userId,
        currency: walletAuthorizations.currency,
        amount: walletAuthorizations.amount,
      });
    if (claimed.length === 0) {
      return replaySettle(tx, input.refType, input.refId);
    }
    const claim = claimed[0];
    if (!claim) throw new Error('wallet settle cas returned empty');
    const held = new Decimal(claim.amount);
    if (settleAmount.gt(held)) {
      throw new SettleExceedsHoldError(toStorage(held), input.amount);
    }

    const account = await lockAccount(tx, claim.userId, claim.currency);
    const balanceAfter = new Decimal(account.balance).minus(settleAmount);
    const inFlightAfter = new Decimal(account.inFlight).minus(held);
    await tx.insert(walletTransactions).values({
      userId: claim.userId,
      currency: claim.currency,
      kind: 'settle',
      refType: input.refType,
      refId: input.refId,
      amount: toStorage(settleAmount.neg()),
      balanceBefore: account.balance,
      balanceAfter: toStorage(balanceAfter),
      authorizationId: claim.id,
      memo: input.memo,
    });
    await tx
      .update(walletAccounts)
      .set({
        balance: toStorage(balanceAfter),
        inFlight: toStorage(inFlightAfter),
        updatedAt: new Date(),
      })
      .where(
        and(eq(walletAccounts.userId, claim.userId), eq(walletAccounts.currency, claim.currency)),
      );
    return {
      authorizationId: claim.id,
      settledAmount: normalizeAmount(input.amount),
      balanceAfter: toStorage(balanceAfter),
      releasedRemainder: toStorage(held.minus(settleAmount)),
      replayed: false,
    };
  });
}

/** CAS 失败分支：settled → 重放首次结果；released/expired → 状态机拒绝 */
async function replaySettle(
  tx: Tx,
  refType: string,
  refId: string,
): Promise<SettleResult> {
  const auth = await findAuthorization(tx, refType, refId);
  if (!auth) throw new AuthorizationNotFoundError(refType, refId);
  if (auth.status === 'settled') {
    const [account] = await tx
      .select({ balance: walletAccounts.balance })
      .from(walletAccounts)
      .where(
        and(eq(walletAccounts.userId, auth.userId), eq(walletAccounts.currency, auth.currency)),
      );
    return {
      authorizationId: auth.id,
      settledAmount: auth.settledAmount ?? '0',
      balanceAfter: account?.balance ?? '0',
      releasedRemainder: new Decimal(auth.amount).minus(auth.settledAmount ?? '0').toString(),
      replayed: true,
    };
  }
  throw new AuthorizationNotActiveError(refType, refId, auth.status);
}
