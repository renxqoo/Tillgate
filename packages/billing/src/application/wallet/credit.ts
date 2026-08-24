/**
 * credit 动词：入账（充值/赠送/返佣）——双腿 [本方 +a, 对手科目 −a]。
 * 幂等三段式：快速路径重放 → 唯一冲突兜底重放 → 同键异命令 409；
 * 跨用户键劫持归属前置于指纹（ref_key_conflict，不是把别人的交易当自己的重放）。
 */
import { DefectError } from '@tillgate/errors';
import { commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { parsePositiveAmount } from '../../domain/money.js';
import { OUTSIDE_ACCOUNT } from '../../domain/wallet/accounts.js';
import { assertInternalCode } from '../../domain/wallet/guards.js';
import { assertRefKey, resolveCurrency, type TxChannel } from './input.js';
import { post, withTx } from './posting.js';
import { replayLegged } from './replay.js';
import type { WalletEnv } from './wallet.js';

export interface CreditInput extends TxChannel {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
  /** 对手内部科目（默认 outside：外部世界镜像） */
  counterparty?: string;
}

export interface CreditResult {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

// eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
export function createCreditUseCase(env: WalletEnv) {
  const { store, guards, currency: defaultCurrency } = env;
  // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
  return async function credit(input: CreditInput): Promise<CreditResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    const counterparty = input.counterparty ?? OUTSIDE_ACCOUNT;
    assertInternalCode(guards, counterparty);
    const amount = parsePositiveAmount(input.amount);
    const fingerprint = commandFingerprint('credit', {
      userId: input.userId,
      currency,
      amount: normalizeAmount(input.amount),
      counterparty,
      memo: input.memo ?? null,
    });

    const prior = await store.read((conn) =>
      store.findTransaction(conn, input.refType, input.refId, 'credit'),
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
          'credit',
          normalizeAmount(input.amount),
        ),
      );
    }

    try {
      return await withTx(store, input.tx, async (tx) => {
        const userAccountId = await store.ensureUserAccount(tx, input.userId, currency);
        const cpAccountId = await store.ensureInternalAccount(tx, counterparty, currency);
        const posted = await post(store, tx, {
          kind: 'credit',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
          commandFingerprint: fingerprint,
          legs: [
            { accountId: userAccountId, currency, amount },
            { accountId: cpAccountId, currency, amount: amount.neg() },
          ],
        });
        const balanceAfter = posted.balanceAfter.get(userAccountId);
        if (balanceAfter === undefined) {
          throw new DefectError('credit.balance_missing', 'billing.wallet_invariant');
        }
        return {
          transactionId: posted.transactionId,
          amount: normalizeAmount(input.amount),
          balanceAfter,
          replayed: false,
        };
      });
    } catch (error) {
      if (store.isUniqueViolation(error)) {
        const existing = await store.read((conn) =>
          store.findTransaction(conn, input.refType, input.refId, 'credit'),
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
              'credit',
              normalizeAmount(input.amount),
            ),
          );
        }
      }
      throw error;
    }
  };
}
