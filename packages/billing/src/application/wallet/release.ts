/**
 * release 动词：取消冻结——CAS active→released + 在途归还。
 * 审计在冻结单本身（reason + 释放指纹），不落交易（零额噪声行取消）；
 * released 重放幂等（返回首笔金额）；settled/expired 是真拒绝（authorization_not_active）。
 */
import { DefectError } from '@tillgate/errors';
import { commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { Decimal, toStorage } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import { assertReleasable } from '../../domain/wallet/authorization.js';
import { assertRefKey, type TxChannel } from './input.js';
import { withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

export interface ReleaseInput extends TxChannel {
  refType: string;
  refId: string;
  reason: string;
}

export interface ReleaseResult {
  authorizationId: string;
  releasedAmount: string;
  replayed: boolean;
}

export function createReleaseUseCase(env: WalletEnv) {
  const { store, guards } = env;
  return async function release(input: ReleaseInput): Promise<ReleaseResult> {
    assertRefKey(guards, input.refType, input.refId);
    const fingerprint = commandFingerprint('release', { reason: input.reason });

    return withTx(store, input.tx, async (tx) => {
      const current = await store.lockAuthorization(tx, input.refType, input.refId);
      if (!current) {
        throw BillingErrors.business('authorization_not_found', {
          refType: input.refType,
          refId: input.refId,
        });
      }
      if (current.status !== 'active') {
        // released 重放幂等（不比对释放指纹）；settled/expired 是真拒绝
        if (current.status === 'released') {
          return {
            authorizationId: current.id,
            releasedAmount: normalizeAmount(current.amount),
            replayed: true,
          };
        }
        assertReleasable(current);
      }
      const released = await store.casReleaseAuthorization(
        tx,
        current.id,
        input.reason,
        fingerprint,
      );
      if (!released) throw new DefectError('release.cas_lost', 'billing.wallet_invariant');
      // 释放预占不动资金——容忍风控冻结（裸锁只取在途快照；settle 仍拒绝冻结账户）
      const [holder] = await store.lockAccounts(tx, [released.accountId]);
      if (!holder) throw new DefectError('release.holder_missing', 'billing.wallet_invariant');
      await store.setInFlight(
        tx,
        released.accountId,
        toStorage(new Decimal(holder.inFlight).minus(released.amount)),
      );
      return {
        authorizationId: current.id,
        releasedAmount: normalizeAmount(released.amount),
        replayed: false,
      };
    });
  };
}
