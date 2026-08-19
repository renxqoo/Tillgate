/**
 * credit 用例：入账（充值/赠送/返佣）——双腿 [本方 +a, 对手科目 −a]。
 * 幂等三段式：快速路径重放 → 唯一冲突兜底重放 → 同键异命令 409；
 * 跨用户键劫持归属前置于指纹（RefKeyConflict，不是把别人的交易当自己的重放）。
 */
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx, readOnly } from '../context.js';
import { assertInternalCode } from '@ai-gateway/domain';
import { commandFingerprint } from '@ai-gateway/domain';
import { normalizeAmount, parsePositiveAmount } from '@ai-gateway/domain';
import { post, withTx } from './posting.js';
import { replayLegged } from './replay.js';
import { OUTSIDE_ACCOUNT } from '@ai-gateway/domain';
import { assertRefKey } from './ref-key.js';
import { resolveCurrency } from './currency.js';
import type { TxInjection, WalletEnv } from './env.js';

export interface CreditInput extends TxInjection {
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

export function createCreditUseCase(env: WalletEnv) {
  const { db, guards, currency: defaultCurrency } = env;
  const repos = env.repos ?? createRepositories();
  return async function credit(ctx: RunContext, input: CreditInput): Promise<CreditResult> {
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

    const c0 = readOnly(ctx, db);
    const prior = await repos.wallet.findTransaction(c0, input.refType, input.refId, 'credit');
    if (prior) return replayLegged(repos, c0, prior, input, input.userId, currency, fingerprint, 'credit');

    try {
      return await withTx(db, input.tx, async (tx) => {
        const c = inTx(ctx, tx);
        const userAccountId = await repos.wallet.ensureUserAccount(c, input.userId, currency);
        const cpAccountId = await repos.wallet.ensureInternalAccount(c, counterparty, currency);
        const posted = await post(repos, c, {
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
        const existing = await repos.wallet.findTransaction(conn, input.refType, input.refId, 'credit');
        if (existing) {
          return replayLegged(repos, conn, existing, input, input.userId, currency, fingerprint, 'credit');
        }
      }
      throw error;
    }
  };
}
