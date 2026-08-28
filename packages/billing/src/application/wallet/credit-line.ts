/**
 * setCreditLimit 动词：授信地板——审计交易（credit_line 单零腿 + creditLimitAfter 回执）
 * + 覆盖校验（新授信必须盖住负余额与全部在途）。
 * 唯一冲突兜底不把输入当回执——重读存储交易，指纹比对通过后返回**存储的**
 * creditLimitAfter（稳定回执），同键异额命令吃 idempotency_conflict。
 */
import { DefectError } from '@tillgate/errors';
import { assertCommandFingerprint, commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { Decimal, parseNonNegativeAmount, toStorage } from '../../domain/money.js';
import { assertCreditLimitCoversExposure } from '../../domain/wallet/exposure.js';
import { assertRefKey, resolveCurrency, type TxChannel } from './input.js';
import { lockActiveAccounts, post, withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

export interface SetCreditLimitInput extends TxChannel {
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

// eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
export function createSetCreditLimitUseCase(env: WalletEnv) {
  const { store, guards, currency: defaultCurrency } = env;
  // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
  return async function setCreditLimit(input: SetCreditLimitInput): Promise<SetCreditLimitResult> {
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

    const prior = await store.read((conn) =>
      store.findTransaction(conn, refType, refId, 'credit_line'),
    );
    if (prior) {
      assertCommandFingerprint(prior.commandFingerprint, fingerprint, {
        refType,
        refId,
        kind: 'credit_line',
      });
      // receipt_ck 约束保证 credit_line 行必有回执值;缺回执即账本破损,按缺陷暴露
      if (prior.creditLimitAfter == null) {
        throw new DefectError('credit_line.replay_receipt_missing', 'billing.wallet_invariant');
      }
      return { creditLimitAfter: normalizeAmount(prior.creditLimitAfter), replayed: true };
    }

    try {
      return await withTx(store, input.tx, async (tx) => {
        const accountId = await store.ensureUserAccount(tx, input.userId, currency);
        const locked = await lockActiveAccounts(store, tx, [accountId]);
        const account = locked.get(accountId);
        if (account === undefined) {
          throw new DefectError('credit_line.account_lock_missing', 'billing.wallet_invariant');
        }
        assertCreditLimitCoversExposure(account, limit, input.userId);
        await post(store, tx, {
          kind: 'credit_line',
          refType,
          refId,
          commandFingerprint: fingerprint,
          creditLimitAfter: toStorage(limit),
          legs: [{ accountId, currency, amount: new Decimal(0) }],
        });
        await store.setCreditLimit(tx, accountId, toStorage(limit));
        return { creditLimitAfter: normalizeAmount(input.amount), replayed: false };
      });
    } catch (error) {
      if (store.isUniqueViolation(error)) {
        // 并发同键输家必须重读 + 指纹比对——同键异额在此吃 409，
        // 绝不把自己的输入当回执返回
        const existing = await store.read((conn) =>
          store.findTransaction(conn, refType, refId, 'credit_line'),
        );
        if (existing) {
          assertCommandFingerprint(existing.commandFingerprint, fingerprint, {
            refType,
            refId,
            kind: 'credit_line',
          });
          if (existing.creditLimitAfter == null) {
            throw new DefectError('credit_line.replay_receipt_missing', 'billing.wallet_invariant');
          }
          return { creditLimitAfter: normalizeAmount(existing.creditLimitAfter), replayed: true };
        }
      }
      throw error;
    }
  };
}
