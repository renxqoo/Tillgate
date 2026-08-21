/**
 * setCreditLimit 用例：授信地板——审计交易（credit_line 单零腿 + creditLimitAfter 回执）
 * + 覆盖校验（新授信必须盖住负余额与全部在途）。
 */
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx, readOnly } from '../context.js';
import { assertCreditLimitCoversExposure } from '@ai-gateway/domain';
import { assertCommandFingerprint, commandFingerprint } from '@ai-gateway/domain';
import {
  Decimal,
  normalizeAmount,
  parseNonNegativeAmount,
  toStorage,
} from '@ai-gateway/domain';
import { lockActiveAccounts, post, withTx } from './posting.js';
import { assertRefKey } from '././ref-key.js';
import { resolveCurrency } from '././currency.js';
import type { TxInjection, WalletEnv } from '././env.js';

export interface SetCreditLimitInput extends TxInjection {
  userId: number;
  amount: string;
  refType?: string;
  refId?: string;
  currency?: string;
}

export interface SetCreditLimitResult {
  creditLimitAfter: string;
  replayed: boolean;
}

export function createSetCreditLimitUseCase(env: WalletEnv) {
  const { db, guards, currency: defaultCurrency } = env;
  const repos = env.repos ?? createRepositories();
  return async function setCreditLimit(
    ctx: RunContext,
    input: SetCreditLimitInput,
  ): Promise<SetCreditLimitResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    const refType = input.refType ?? 'admin';
    const refId = input.refId ?? `credit-line:${input.userId}`;
    assertRefKey(guards, refType, refId);
    const limit = parseNonNegativeAmount(input.amount);
    const fingerprint = commandFingerprint('credit_line', {
      userId: input.userId,
      currency,
      amount: normalizeAmount(input.amount),
    });

    const c0 = readOnly(ctx, db);
    const prior = await repos.wallet.findTransaction(c0, refType, refId, 'credit_line');
    if (prior) {
      assertCommandFingerprint(prior.commandFingerprint, fingerprint, refType, refId, 'credit_line');
      return { creditLimitAfter: normalizeAmount(input.amount), replayed: true };
    }

    try {
      return await withTx(db, input.tx, async (tx) => {
        const c = inTx(ctx, tx);
        const accountId = await repos.wallet.ensureUserAccount(c, input.userId, currency);
        const locked = await lockActiveAccounts(repos, c, [accountId]);
        const account = locked.get(accountId)!;
        assertCreditLimitCoversExposure(account, limit, input.userId);
        await post(repos, c, {
          kind: 'credit_line',
          refType,
          refId,
          commandFingerprint: fingerprint,
          creditLimitAfter: toStorage(limit),
          legs: [{ accountId, currency, amount: new Decimal(0) }],
        });
        await repos.wallet.setCreditLimit(c, accountId, toStorage(limit));
        return { creditLimitAfter: normalizeAmount(input.amount), replayed: false };
      });
    } catch (error) {
      if (repos.wallet.isUniqueViolation(error)) {
        return { creditLimitAfter: normalizeAmount(input.amount), replayed: true };
      }
      throw error;
    }
  };
}
