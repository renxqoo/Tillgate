/**
 * refund 用例：退款——双腿 [本方 −a, 对手科目 +a]（钱离开余额原路退回，缺省 outside；
 * 费用承担类退款可指定其他科目）。出账守卫（信用口径）+ 幂等三段式。
 */
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx, readOnly } from '../context.js';
import { assertCanDebit } from '@ai-gateway/domain';
import { assertInternalCode, OUTSIDE_ACCOUNT } from '@ai-gateway/domain';
import { commandFingerprint } from '@ai-gateway/domain';
import { normalizeAmount, parsePositiveAmount } from '@ai-gateway/domain';
import { lockActiveAccounts, post, withTx } from './posting.js';
import { replayLegged } from './replay.js';
import { resolveCurrency } from './currency.js';
import { assertRefKey } from './ref-key.js';
import type { TxInjection, WalletEnv } from './env.js';

export interface RefundInput extends TxInjection {
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
  const { db, guards, currency: defaultCurrency } = env;
  const repos = env.repos ?? createRepositories();
  return async function refund(ctx: RunContext, input: RefundInput): Promise<RefundResult> {
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

    const c0 = readOnly(ctx, db);
    const prior = await repos.wallet.findTransaction(c0, input.refType, input.refId, 'refund');
    if (prior) {
      return replayLegged(repos, c0, prior, input, input.userId, currency, fingerprint, 'refund');
    }

    try {
      return await withTx(db, input.tx, async (tx) => {
        const c = inTx(ctx, tx);
        const userAccountId = await repos.wallet.ensureUserAccount(c, input.userId, currency);
        const cpAccountId = await repos.wallet.ensureInternalAccount(c, counterparty, currency);
        const locked = await lockActiveAccounts(repos, c, [userAccountId, cpAccountId]);
        const user = locked.get(userAccountId)!;
        assertCanDebit(user, amount, input.userId);
        const posted = await post(repos, c, {
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
      if (repos.wallet.isUniqueViolation(error)) {
        const conn = readOnly(ctx, db);
        const existing = await repos.wallet.findTransaction(conn, input.refType, input.refId, 'refund');
        if (existing) {
          return replayLegged(repos, conn, existing, input, input.userId, currency, fingerprint, 'refund');
        }
      }
      throw error;
    }
  };
}
