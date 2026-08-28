/**
 * transfer 动词：划转——双腿 [from −a, to +a]；from 为用户账户时守卫（信用/现金口径）。
 * 内部科目账户语义可负（守恒由 Σ腿=0 保证），不做借记守卫。
 */
import { DefectError } from '@tillgate/errors';
import { assertCommandFingerprint, commandFingerprint } from '../../domain/fingerprint.js';
import type { FingerprintValue } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { parsePositiveAmount } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import type { AccountRef } from '../../domain/wallet/accounts.js';
import { assertInternalCode } from '../../domain/wallet/guards.js';
import { assertCanDebit } from '../../domain/wallet/exposure.js';
import type { TransactionHeader, WalletConn, WalletStore } from '../../ports/wallet-store.js';
import { assertRefKey, resolveCurrency, type TxChannel } from './input.js';
import { lockActiveAccounts, post, withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

export interface TransferInput extends TxChannel {
  from: AccountRef;
  to: AccountRef;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
  allowCredit?: boolean;
}

export interface TransferResult {
  transactionId: number;
  fromBalanceAfter: string;
  toBalanceAfter: string;
  replayed: boolean;
}

// eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
export function createTransferUseCase(env: WalletEnv) {
  const { store, guards, currency: defaultCurrency } = env;
  // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤
  return async function transfer(input: TransferInput): Promise<TransferResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    if ('code' in input.from) assertInternalCode(guards, input.from.code);
    if ('code' in input.to) assertInternalCode(guards, input.to.code);
    const amount = parsePositiveAmount(input.amount);
    // 只在显式 false 时进指纹：缺省与 true 语义等价（条件构造——严格指纹不收 undefined）
    const payload: Record<string, FingerprintValue> = {
      from: input.from,
      to: input.to,
      currency,
      amount: normalizeAmount(input.amount),
      memo: input.memo ?? null,
    };
    if (input.allowCredit === false) payload.allowCredit = false;
    const fingerprint = commandFingerprint('transfer', payload);

    const prior = await store.read((conn) =>
      store.findTransaction(conn, input.refType, input.refId, 'transfer'),
    );
    if (prior) {
      return store.read((conn) => replayTransfer(store, conn, prior, input, currency, fingerprint));
    }

    try {
      return await withTx(store, input.tx, async (tx) => {
        const fromId =
          'userId' in input.from
            ? await store.ensureUserAccount(tx, input.from.userId, currency)
            : await store.ensureInternalAccount(tx, input.from.code, currency);
        const toId =
          'userId' in input.to
            ? await store.ensureUserAccount(tx, input.to.userId, currency)
            : await store.ensureInternalAccount(tx, input.to.code, currency);
        const locked = await lockActiveAccounts(store, tx, [fromId, toId]);
        const from = locked.get(fromId);
        if (from === undefined) {
          throw new DefectError('transfer.from_lock_missing', 'billing.wallet_invariant');
        }
        // 出账守卫仅在 from 为用户引用时触达，userId 取窄化后的真值（不携带误导 0）
        if (from.kind === 'user' && 'userId' in input.from) {
          assertCanDebit(from, amount, input.from.userId, { allowCredit: input.allowCredit });
        }
        const posted = await post(store, tx, {
          kind: 'transfer',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo,
          commandFingerprint: fingerprint,
          legs: [
            { accountId: fromId, currency, amount: amount.neg() },
            { accountId: toId, currency, amount },
          ],
        });
        const fromBalanceAfter = posted.balanceAfter.get(fromId);
        const toBalanceAfter = posted.balanceAfter.get(toId);
        if (fromBalanceAfter === undefined || toBalanceAfter === undefined) {
          throw new DefectError('transfer.balance_missing', 'billing.wallet_invariant');
        }
        return {
          transactionId: posted.transactionId,
          fromBalanceAfter,
          toBalanceAfter,
          replayed: false,
        };
      });
    } catch (error) {
      if (store.isUniqueViolation(error)) {
        const existing = await store.read((conn) =>
          store.findTransaction(conn, input.refType, input.refId, 'transfer'),
        );
        if (existing) {
          return store.read((conn) =>
            replayTransfer(store, conn, existing, input, currency, fingerprint),
          );
        }
      }
      throw error;
    }
  };
}

// eslint-disable-next-line max-params -- 导出钱包动词契约(重放入口)
async function replayTransfer(
  store: WalletStore,
  conn: WalletConn,
  prior: TransactionHeader,
  input: TransferInput,
  currency: string,
  fingerprint: string,
): Promise<TransferResult> {
  // 归属前置于指纹：from 方在该交易上无腿 = 幂等键不属于他
  const fromId = await findAccountId(store, conn, input.from, currency);
  const fromLeg = fromId ? await store.findLeg(conn, prior.id, fromId) : null;
  if (!fromLeg) {
    throw BillingErrors.business('ref_key_conflict', {
      refType: input.refType,
      refId: input.refId,
      ownerUserId: 0,
    });
  }
  const toId = await findAccountId(store, conn, input.to, currency);
  const toLeg = toId ? await store.findLeg(conn, prior.id, toId) : null;
  if (!toLeg) throw new DefectError('transfer.replay_leg_missing', 'billing.wallet_invariant');
  assertCommandFingerprint(prior.commandFingerprint, fingerprint, {
    refType: input.refType,
    refId: input.refId,
    kind: 'transfer',
  });
  return {
    transactionId: prior.id,
    fromBalanceAfter: normalizeAmount(fromLeg.balanceAfter),
    toBalanceAfter: normalizeAmount(toLeg.balanceAfter),
    replayed: true,
  };
}

// eslint-disable-next-line max-params -- 导出钱包动词契约(对账入口)
async function findAccountId(
  store: WalletStore,
  conn: WalletConn,
  ref: AccountRef,
  currency: string,
): Promise<string | null> {
  return 'userId' in ref
    ? store.findUserAccountId(conn, ref.userId, currency)
    : store.findInternalAccountId(conn, ref.code, currency);
}
