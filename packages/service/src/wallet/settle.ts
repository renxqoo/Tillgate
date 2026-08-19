/**
 * settle 用例：实扣落定——行锁 → 领域校验 → CAS active→settled → 双腿
 * [持有人 −a, 收入科目 +a] → 在途全额归还（余量随结算释放）。
 * 非 active 分支：settled → 指纹重放首答；released/expired → NotActive。
 */
import type { RepoContext } from '@ai-gateway/repository';
import type { AuthorizationRow } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import { assertSettleable } from '@ai-gateway/domain';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  WalletInvariantError,
} from '@ai-gateway/domain';
import { assertInternalCode } from '@ai-gateway/domain';
import { assertCommandFingerprint, commandFingerprint } from '@ai-gateway/domain';
import { Decimal, normalizeAmount, parsePositiveAmount, toStorage } from '@ai-gateway/domain';
import { lockActiveAccounts, post, withTx } from './posting.js';
import { REVENUE_ACCOUNT } from '@ai-gateway/domain';
import { assertRefKey } from '././ref-key.js';
import type { TxInjection, WalletEnv } from '././env.js';

export interface SettleInput extends TxInjection {
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

export function createSettleUseCase(env: WalletEnv) {
  const { db, guards } = env;
  const repos = env.repos ?? createRepositories();
  return async function settle(ctx: RunContext, input: SettleInput): Promise<SettleResult> {
    assertRefKey(guards, input.refType, input.refId);
    const settleAmount = parsePositiveAmount(input.amount);
    const counterparty = input.counterparty ?? REVENUE_ACCOUNT;
    assertInternalCode(guards, counterparty);
    const fingerprint = commandFingerprint('settle', {
      amount: normalizeAmount(input.amount),
      counterparty,
      memo: input.memo ?? null,
    });

    return withTx(db, input.tx, async (tx) => {
      const c = inTx(ctx, tx);
      // 先锁再做领域校验；避免 DB 状态约束把超额结算泄漏成原始 23514
      const current = await repos.wallet.lockAuthorization(c, input.refType, input.refId);
      if (!current) throw new AuthorizationNotFoundError(input.refType, input.refId);
      if (current.status !== 'active') {
        return replaySettle(repos, c, current, fingerprint);
      }
      assertSettleable(current, settleAmount, await repos.wallet.databaseNow(c));

      const claimed = await repos.wallet.casSettleAuthorization(c, current.id, toStorage(settleAmount));
      if (!claimed) throw new WalletInvariantError('settle.cas_lost');

      const holderAccount = (await lockActiveAccounts(repos, c, [claimed.accountId])).get(claimed.accountId)!;
      const cpAccountId = await repos.wallet.ensureInternalAccount(c, counterparty, holderAccount.currency);
      const posted = await post(repos, c, {
        kind: 'settle',
        refType: input.refType,
        refId: input.refId,
        memo: input.memo,
        commandFingerprint: fingerprint,
        legs: [
          { accountId: claimed.accountId, currency: holderAccount.currency, amount: settleAmount.neg() },
          { accountId: cpAccountId, currency: holderAccount.currency, amount: settleAmount },
        ],
      });
      // 在途全额归还（余量随结算释放）
      await repos.wallet.setInFlight(
        c,
        claimed.accountId,
        toStorage(new Decimal(holderAccount.inFlight).minus(claimed.heldAmount)),
      );
      return {
        authorizationId: current.id,
        settledAmount: normalizeAmount(input.amount),
        balanceAfter: posted.balanceAfter.get(claimed.accountId)!,
        releasedRemainder: toStorage(new Decimal(claimed.heldAmount).minus(settleAmount)),
        replayed: false,
      };
    });
  };
}

/** settle 的非 active 分支：settled → 重放首答；released/expired → 拒绝 */
async function replaySettle(
  repos: Repositories,
  c: RepoContext,
  auth: AuthorizationRow,
  fingerprint: string,
): Promise<SettleResult> {
  if (auth.status === 'settled') {
    const priorTx = await repos.wallet.findTransaction(c, auth.refType, auth.refId, 'settle');
    if (!priorTx) throw new WalletInvariantError('settle.replay_tx_missing');
    assertCommandFingerprint(priorTx.commandFingerprint, fingerprint, auth.refType, auth.refId, 'settle');
    const leg = await repos.wallet.findLeg(c, priorTx.id, auth.accountId);
    if (!leg) throw new WalletInvariantError('settle.replay_leg_missing');
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
  throw new AuthorizationNotActiveError(auth.refType, auth.refId, auth.status);
}
