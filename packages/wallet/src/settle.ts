/** settle：实扣落定——CAS active→settled + 双腿 [持有人 −a, 收入科目 +a]（结算即收入确认）；
 *  可少于冻结额（余量即归还）；重放返回首次结果。 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  SettleExceedsHoldError,
  WalletInternalError,
} from './errors';
import {
  walletAccounts,
  walletAuthorizations,
  walletTransactions,
} from './schema';
import { lockAccounts, resolveInternalAccount } from './account';
import { applyLeg } from './legs';
import { findAuthorization } from './authorizations';
import { parseAmount, parseRef } from './validation';
import { REVENUE_ACCOUNT } from './types';
import type { SettleInput, SettleResult } from './types';
import { runTx, type Tx } from './internal';

export async function settle(db: NodePgDatabase, input: SettleInput): Promise<SettleResult> {
  parseRef(input);
  const settleAmount = parseAmount(input.amount);
  const counterparty = input.counterparty ?? REVENUE_ACCOUNT;

  return runTx(db, async (tx) => {
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
        accountId: walletAuthorizations.accountId,
        amount: walletAuthorizations.amount,
      });
    if (claimed.length === 0) {
      return replaySettle(tx, input.refType, input.refId);
    }
    const claim = claimed[0];
    if (!claim) throw new WalletInternalError('settle.cas_empty');
    const held = new Decimal(claim.amount);
    if (settleAmount.gt(held)) {
      throw new SettleExceedsHoldError(toStorage(held), input.amount);
    }

    const holder = (await lockAccounts(tx, [claim.accountId])).get(claim.accountId)!;
    const cpAccountId = await resolveInternalAccount(tx, counterparty, holder.currency);
    const accounts = await lockAccounts(tx, [claim.accountId, cpAccountId]);
    const cp = accounts.get(cpAccountId)!;

    const [header] = await tx
      .insert(walletTransactions)
      .values({ kind: 'settle', refType: input.refType, refId: input.refId, memo: input.memo })
      .returning({ id: walletTransactions.id });
    if (!header) throw new WalletInternalError('settle.insert');

    const holderAfter = await applyLeg(
      tx, header.id, claim.accountId, holder.currency, settleAmount.neg(), holder.balance,
    );
    await applyLeg(
      tx, header.id, cpAccountId, holder.currency, settleAmount, cp.balance,
    );
    // 在途全额归还（余量随结算释放）
    await tx
      .update(walletAccounts)
      .set({ inFlight: toStorage(new Decimal(holder.inFlight).minus(held)), updatedAt: new Date() })
      .where(eq(walletAccounts.id, claim.accountId));
    return {
      authorizationId: claim.id,
      settledAmount: normalizeAmount(input.amount),
      balanceAfter: holderAfter,
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
      .where(eq(walletAccounts.id, auth.accountId));
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
