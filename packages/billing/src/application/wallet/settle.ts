/**
 * settle 动词：实扣落定——行锁 → 领域校验 → CAS active→settled → 双腿
 * [持有人 −a, 收入科目 +a] → 在途全额归还（余量随结算释放）。
 * 非 active 分支：settled → 指纹重放首答；released/expired → authorization_not_active。
 */
import { DefectError } from '@tillgate/errors';
import { assertCommandFingerprint, commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { Decimal, parsePositiveAmount, toStorage } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import { assertSettleable } from '../../domain/wallet/authorization.js';
import type { AuthorizationSnapshot } from '../../domain/wallet/authorization.js';
import { REVENUE_ACCOUNT } from '../../domain/wallet/accounts.js';
import { assertInternalCode } from '../../domain/wallet/guards.js';
import type { WalletConn, WalletStore } from '../../ports/wallet-store.js';
import { assertRefKey, type TxChannel } from './input.js';
import { lockActiveAccounts, post, withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

export interface SettleInput extends TxChannel {
  refType: string;
  refId: string;
  amount: string;
  currency?: string;
  memo?: string;
  /** 收入确认科目（默认 platform_revenue） */
  counterparty?: string;
}

export interface SettleResult {
  authorizationId: string;
  settledAmount: string;
  balanceAfter: string;
  /** 冻结余量随结算归还 */
  releasedRemainder: string;
  replayed: boolean;
}

// eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤,拆分需跨闭包共享 tx
export function createSettleUseCase(env: WalletEnv) {
  const { store, guards } = env;
  // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤,拆分需跨闭包共享 tx
  return async function settle(input: SettleInput): Promise<SettleResult> {
    assertRefKey(guards, input.refType, input.refId);
    const settleAmount = parsePositiveAmount(input.amount);
    const counterparty = input.counterparty ?? REVENUE_ACCOUNT;
    assertInternalCode(guards, counterparty);
    const fingerprint = commandFingerprint('settle', {
      amount: normalizeAmount(input.amount),
      counterparty,
      memo: input.memo ?? null,
    });

    // eslint-disable-next-line max-lines-per-function -- 资金动词事务体:锁账→守卫→过账→回执顺序步骤,拆分需跨闭包共享 tx
    return withTx(store, input.tx, async (tx) => {
      // 先锁再做领域校验；避免 DB 状态约束把超额结算泄漏成原始 23514
      const current = await store.lockAuthorization(tx, input.refType, input.refId);
      if (!current) {
        throw BillingErrors.business('authorization_not_found', {
          refType: input.refType,
          refId: input.refId,
        });
      }
      if (current.status !== 'active') {
        return replaySettle(store, tx, current, fingerprint);
      }
      assertSettleable(current, settleAmount, await store.databaseNow(tx));

      const claimed = await store.casSettleAuthorization(tx, current.id, toStorage(settleAmount));
      if (!claimed) throw new DefectError('settle.cas_lost', 'billing.wallet_invariant');

      const holderAccount = (await lockActiveAccounts(store, tx, [claimed.accountId])).get(
        claimed.accountId,
      );
      if (holderAccount === undefined) {
        throw new DefectError('settle.holder_lock_missing', 'billing.wallet_invariant');
      }
      const cpAccountId = await store.ensureInternalAccount(
        tx,
        counterparty,
        holderAccount.currency,
      );
      const posted = await post(store, tx, {
        kind: 'settle',
        refType: input.refType,
        refId: input.refId,
        memo: input.memo,
        commandFingerprint: fingerprint,
        legs: [
          {
            accountId: claimed.accountId,
            currency: holderAccount.currency,
            amount: settleAmount.neg(),
          },
          { accountId: cpAccountId, currency: holderAccount.currency, amount: settleAmount },
        ],
      });
      // 在途全额归还（余量随结算释放）
      await store.setInFlight(
        tx,
        claimed.accountId,
        toStorage(new Decimal(holderAccount.inFlight).minus(claimed.heldAmount)),
      );
      const balanceAfter = posted.balanceAfter.get(claimed.accountId);
      if (balanceAfter === undefined) {
        throw new DefectError('settle.balance_missing', 'billing.wallet_invariant');
      }
      return {
        authorizationId: current.id,
        settledAmount: normalizeAmount(input.amount),
        balanceAfter,
        releasedRemainder: toStorage(new Decimal(claimed.heldAmount).minus(settleAmount)),
        replayed: false,
      };
    });
  };
}

/** settle 的非 active 分支：settled → 重放首答；released/expired → 拒绝 */
// eslint-disable-next-line max-params -- 导出钱包动词契约,调用点在网关热路径
async function replaySettle(
  store: WalletStore,
  conn: WalletConn,
  auth: AuthorizationSnapshot,
  fingerprint: string,
): Promise<SettleResult> {
  if (auth.status === 'settled') {
    const priorTx = await store.findTransaction(conn, auth.refType, auth.refId, 'settle');
    if (!priorTx) throw new DefectError('settle.replay_tx_missing', 'billing.wallet_invariant');
    assertCommandFingerprint(priorTx.commandFingerprint, fingerprint, {
      refType: auth.refType,
      refId: auth.refId,
      kind: 'settle',
    });
    const leg = await store.findLeg(conn, priorTx.id, auth.accountId);
    if (!leg) throw new DefectError('settle.replay_leg_missing', 'billing.wallet_invariant');
    return {
      authorizationId: auth.id,
      settledAmount: normalizeAmount(auth.settledAmount ?? '0'),
      balanceAfter: normalizeAmount(leg.balanceAfter),
      releasedRemainder: normalizeAmount(
        new Decimal(auth.amount).minus(auth.settledAmount ?? '0').toString(),
      ),
      replayed: true,
    };
  }
  throw BillingErrors.business('authorization_not_active', {
    refType: auth.refType,
    refId: auth.refId,
    status: auth.status,
  });
}
