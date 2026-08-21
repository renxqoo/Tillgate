/**
 * 腿级交易重放（credit / refund 共享件）：归属校验（键劫持 → RefKeyConflict）前置于
 * 指纹比对 → 读回首答回执。归属前置 = 本用户在该交易上无腿，幂等键不属于他。
 */
import { assertCommandFingerprint, normalizeAmount, RefKeyConflictError } from '@ai-gateway/domain';
import type { RepoContext, Repositories, TransactionHeader } from '@ai-gateway/repository';

export interface ReplayedLegReceipt {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

export async function replayLegged(
  repos: Repositories,
  c: RepoContext,
  prior: TransactionHeader,
  input: { refType: string; refId: string },
  userId: number,
  currency: string,
  fingerprint: string,
  kind: 'credit' | 'refund',
): Promise<ReplayedLegReceipt> {
  const accountId = await repos.wallet.findUserAccountId(c, userId, currency);
  const leg = accountId ? await repos.wallet.findLeg(c, prior.id, accountId) : null;
  if (!leg) throw new RefKeyConflictError(input.refType, input.refId, 0);
  assertCommandFingerprint(prior.commandFingerprint, fingerprint, input.refType, input.refId, kind);
  return {
    transactionId: prior.id,
    amount: normalizeAmount(leg.amount),
    balanceAfter: normalizeAmount(leg.balanceAfter),
    replayed: true,
  };
}
