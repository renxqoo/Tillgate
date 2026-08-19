/**
 * release 用例：取消冻结——CAS active→released + 在途归还。
 * 审计在冻结单本身（reason + 释放指纹），不落交易（零额噪声行取消）；
 * released 重放幂等；settled/expired 是真拒绝（NotActive）。
 */
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import { assertReleasable } from '@ai-gateway/domain';
import { AuthorizationNotFoundError, WalletInvariantError } from '@ai-gateway/domain';
import { commandFingerprint } from '@ai-gateway/domain';
import { Decimal, normalizeAmount, toStorage } from '@ai-gateway/domain';
import { lockActiveAccounts, withTx } from './posting.js';
import { assertRefKey } from '././ref-key.js';
import type { TxInjection, WalletEnv } from '././env.js';

export interface ReleaseInput extends TxInjection {
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
  const { db, guards } = env;
  const repos = env.repos ?? createRepositories();
  return async function release(ctx: RunContext, input: ReleaseInput): Promise<ReleaseResult> {
    assertRefKey(guards, input.refType, input.refId);
    const fingerprint = commandFingerprint('release', { reason: input.reason });

    return withTx(db, input.tx, async (tx) => {
      const c = inTx(ctx, tx);
      const current = await repos.wallet.lockAuthorization(c, input.refType, input.refId);
      if (!current) throw new AuthorizationNotFoundError(input.refType, input.refId);
      if (current.status !== 'active') {
        // released 重放幂等；settled/expired 是真拒绝
        if (current.status === 'released') {
          return { authorizationId: current.id, releasedAmount: normalizeAmount(current.amount), replayed: true };
        }
        assertReleasable(current);
      }
      const released = await repos.wallet.casReleaseAuthorization(c, current.id, input.reason, fingerprint);
      if (!released) throw new WalletInvariantError('release.cas_lost');
      const holder = (await lockActiveAccounts(repos, c, [released.accountId])).get(released.accountId)!;
      await repos.wallet.setInFlight(
        c,
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
