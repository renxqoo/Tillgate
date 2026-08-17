/** transfer：原子转账（分账/P2P/手续费）——双腿 [from −a, to +a] 守恒；
 *  from/to 可为用户账户或内部科目；同币种限定（换汇 = 两笔独立转账）。 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  SameAccountTransferError,
} from './errors';
import { WalletInternalError } from './errors';
import { walletTransactions } from './schema';
import { lockAccounts, resolveAccount } from './account';
import { applyLeg } from './legs';
import { isUniqueViolation, runTx } from './internal';
import { hasTransaction, replayTransfer } from './replay';
import { parseAccountRef, parseAmount, parseRef } from './validation';
import type { TransferInput, TransferResult } from './types';

export async function transfer(db: NodePgDatabase, input: TransferInput): Promise<TransferResult> {
  parseRef({ refType: input.refType, refId: input.refId });
  const amount = parseAmount(input.amount);
  const fromCurrency = parseAccountRef(input.from);
  const toCurrency = parseAccountRef(input.to);

  // 幂等快速路径：守卫之前先查已存在（首笔可能已把余额转走，重放不该再过守卫）
  if (await hasTransaction(db, input.refType, input.refId, 'transfer')) {
    return replayTransfer(db, input.refType, input.refId, input.from, input.to);
  }

  try {
    return await runTx(db, async (tx) => {
      const fromId = await resolveAccount(tx, input.from, fromCurrency);
      const toId = await resolveAccount(tx, input.to, toCurrency);
      if (fromId === toId) throw new SameAccountTransferError(fromId);
      const accounts = await lockAccounts(tx, [fromId, toId]);
      const from = accounts.get(fromId)!;
      const to = accounts.get(toId)!;
      if (from.currency !== to.currency) {
        throw new CurrencyMismatchError(from.currency, to.currency);
      }

      // 出账守卫：用户账户按授信地板（balance ≥ −credit_limit）；
      // 内部科目无地板，按不得透支（balance ≥ amount）——守恒由 Σ腿=0 保证
      const fromBalance = new Decimal(from.balance);
      const limit = from.kind === 'internal' ? new Decimal(0) : new Decimal(from.creditLimit);
      const floor = limit.neg();
      if (fromBalance.minus(amount).lt(floor)) {
        throw new InsufficientBalanceError(
          input.from.userId ?? 0,
          toStorage(fromBalance.minus(floor)),
          toStorage(amount),
          from.currency,
        );
      }

      const [header] = await tx
        .insert(walletTransactions)
        .values({
          kind: 'transfer',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
        })
        .returning({ id: walletTransactions.id });
      if (!header) throw new WalletInternalError('transfer.insert');

      const fromAfter = await applyLeg(
        tx, header.id, fromId, from.currency, amount.neg(), from.balance,
      );
      const toAfter = await applyLeg(tx, header.id, toId, to.currency, amount, to.balance);
      return {
        transactionId: header.id,
        amount: normalizeAmount(input.amount),
        fromBalanceAfter: fromAfter,
        toBalanceAfter: toAfter,
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return replayTransfer(db, input.refType, input.refId, input.from, input.to);
    }
    throw error;
  }
}
