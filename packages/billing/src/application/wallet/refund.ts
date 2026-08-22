/**
 * refund 动词：退款——双腿 [本方 −a, 对手科目 +a]（钱离开余额原路退回，缺省 outside；
 * 费用承担类退款可指定其他科目）。出账守卫（信用口径）+ 幂等三段式。
 */
import { commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { parsePositiveAmount } from '../../domain/money.js';
import { OUTSIDE_ACCOUNT } from '../../domain/wallet/accounts.js';
import { assertInternalCode } from '../../domain/wallet/guards.js';
import { assertCanDebit } from '../../domain/wallet/exposure.js';
import { assertRefKey, resolveCurrency, type TxChannel } from './input.js';
import { lockActiveAccounts, post, withTx } from './posting.js';
import { replayLegged } from './replay.js';
import type { WalletEnv } from './wallet.js';

export interface RefundInput extends TxChannel {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
  /** 对手内部科目（默认 outside：外部世界镜像——原路退回） */
  counterparty?: string;
}

export interface RefundResult {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

export function createRefundUseCase(env: WalletEnv) {
  const { store, guards, currency: defaultCurrency } = env;
  return async function refund(input: RefundInput): Promise<RefundResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;
    assertInternalCode(guards, counterparty);
    const amount = parsePositiveAmount(input.amount);
    const fingerprint = commandFingerprint('refund', {
      userId: input.userId,
      currency,
      amount: normalizeAmount(input.amount),
      counterparty,
      memo: input.memo ?? null,
    });

    const prior = await store.read((conn) =>
      store.findTransaction(conn, input.refType, input.refId, 'refund'),
    );
    if (prior) {
      return store.read((conn) =>
        replayLegged(
          store,
          conn,
          prior,
          input,
          input.userId,
          currency,
          fingerprint,
          'refund',
          normalizeAmount(input.amount),
        ),
      );
    }

    try {
      return await withTx(store, input.tx, async (tx) => {
        const userAccountId = await store.ensureUserAccount(tx, input.userId, currency);
        const cpAccountId = await store.ensureInternalAccount(tx, counterparty, currency);
        const locked = await lockActiveAccounts(store, tx, [userAccountId, cpAccountId]);
        const user = locked.get(userAccountId)!;
        assertCanDebit(user, amount, input.userId);
        const posted = await post(store, tx, {
          kind: 'refund',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
          commandFingerprint: fingerprint,
          legs: [
            { accountId: userAccountId, currency, amount: amount.neg() },
            { accountId: cpAccountId, currency, amount },
          ],
        });
        return {
          transactionId: posted.transactionId,
          amount: normalizeAmount(input.amount),
          balanceAfter: posted.balanceAfter.get(userAccountId)!,
          replayed: false,
        };
      });
    } catch (error) {
      if (store.isUniqueViolation(error)) {
        const existing = await store.read((conn) =>
          store.findTransaction(conn, input.refType, input.refId, 'refund'),
        );
        if (existing) {
          return store.read((conn) =>
            replayLegged(
              store,
              conn,
              existing,
              input,
              input.userId,
              currency,
              fingerprint,
              'refund',
              normalizeAmount(input.amount),
            ),
          );
        }
      }
      throw error;
    }
  };
}
