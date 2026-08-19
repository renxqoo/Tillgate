/**
 * transfer 用例：划转——双腿 [from −a, to +a]；from 为用户账户时守卫（信用/现金口径）。
 * 内部科目账户语义可负（守恒由 Σ腿=0 保证），不做借记守卫。
 */
import type { RepoContext } from '@ai-gateway/repository';
import type { TransactionHeader } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx, readOnly } from '../context.js';
import { assertCanDebit, type AccountRef } from '@ai-gateway/domain';
import { RefKeyConflictError, WalletInvariantError } from '@ai-gateway/domain';
import { assertInternalCode } from '@ai-gateway/domain';
import { assertCommandFingerprint, commandFingerprint } from '@ai-gateway/domain';
import { normalizeAmount, parsePositiveAmount } from '@ai-gateway/domain';
import { lockActiveAccounts, post, withTx } from './posting.js';
import { assertRefKey } from '././ref-key.js';
import { resolveCurrency } from '././currency.js';
import type { TxInjection, WalletEnv } from '././env.js';

export interface TransferInput extends TxInjection {
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

export function createTransferUseCase(env: WalletEnv) {
  const { db, guards, currency: defaultCurrency } = env;
  const repos = env.repos ?? createRepositories();
  return async function transfer(ctx: RunContext, input: TransferInput): Promise<TransferResult> {
    const currency = resolveCurrency(guards, defaultCurrency, input);
    assertRefKey(guards, input.refType, input.refId);
    if ('code' in input.from) assertInternalCode(guards, input.from.code);
    if ('code' in input.to) assertInternalCode(guards, input.to.code);
    const amount = parsePositiveAmount(input.amount);
    const fingerprint = commandFingerprint('transfer', {
      from: input.from,
      to: input.to,
      currency,
      amount: normalizeAmount(input.amount),
      allowCredit: input.allowCredit === false ? false : undefined,
      memo: input.memo ?? null,
    });

    const c0 = readOnly(ctx, db);
    const prior = await repos.wallet.findTransaction(c0, input.refType, input.refId, 'transfer');
    if (prior) {
      return replayTransfer(repos, c0, prior, input, currency, fingerprint);
    }

    try {
      return await withTx(db, input.tx, async (tx) => {
        const c = inTx(ctx, tx);
        const fromId =
          'userId' in input.from
            ? await repos.wallet.ensureUserAccount(c, input.from.userId, currency)
            : await repos.wallet.ensureInternalAccount(c, input.from.code, currency);
        const toId =
          'userId' in input.to
            ? await repos.wallet.ensureUserAccount(c, input.to.userId, currency)
            : await repos.wallet.ensureInternalAccount(c, input.to.code, currency);
        const locked = await lockActiveAccounts(repos, c, [fromId, toId]);
        const from = locked.get(fromId)!;
        if (from.kind === 'user') {
          assertCanDebit(from, amount, 'userId' in input.from ? input.from.userId : 0, {
            allowCredit: input.allowCredit,
          });
        }
        const posted = await post(repos, c, {
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
        return {
          transactionId: posted.transactionId,
          fromBalanceAfter: posted.balanceAfter.get(fromId)!,
          toBalanceAfter: posted.balanceAfter.get(toId)!,
          replayed: false,
        };
      });
    } catch (error) {
      if (repos.wallet.isUniqueViolation(error)) {
        const conn = readOnly(ctx, db);
        const existing = await repos.wallet.findTransaction(conn, input.refType, input.refId, 'transfer');
        if (existing) return replayTransfer(repos, conn, existing, input, currency, fingerprint);
      }
      throw error;
    }
  };
}

async function replayTransfer(
  repos: Repositories,
  c: RepoContext,
  prior: TransactionHeader,
  input: TransferInput,
  currency: string,
  fingerprint: string,
): Promise<TransferResult> {
  // 归属前置于指纹：from 方在该交易上无腿 = 幂等键不属于他
  const fromId = await findAccountId(repos, c, input.from, currency);
  const fromLeg = fromId ? await repos.wallet.findLeg(c, prior.id, fromId) : null;
  if (!fromLeg) throw new RefKeyConflictError(input.refType, input.refId, 0);
  const toId = await findAccountId(repos, c, input.to, currency);
  const toLeg = toId ? await repos.wallet.findLeg(c, prior.id, toId) : null;
  if (!toLeg) throw new WalletInvariantError('transfer.replay_leg_missing');
  assertCommandFingerprint(prior.commandFingerprint, fingerprint, input.refType, input.refId, 'transfer');
  return {
    transactionId: prior.id,
    fromBalanceAfter: normalizeAmount(fromLeg.balanceAfter),
    toBalanceAfter: normalizeAmount(toLeg.balanceAfter),
    replayed: true,
  };
}

async function findAccountId(
  repos: Repositories,
  c: RepoContext,
  ref: AccountRef,
  currency: string,
): Promise<string | null> {
  return 'userId' in ref
    ? repos.wallet.findUserAccountId(c, ref.userId, currency)
    : repos.wallet.findInternalAccountId(c, ref.code, currency);
}
