/**
 * 腿级交易重放（credit / refund 共享件）：归属校验（键劫持 → ref_key_conflict）前置于
 * 指纹比对 → 读回首答回执。归属前置 = 本用户在该交易上无腿，幂等键不属于他。
 */
import { assertCommandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import type { TransactionHeader, WalletConn, WalletStore } from '../../ports/wallet-store.js';

export interface ReplayedLegReceipt {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

// eslint-disable-next-line max-params -- 导出重放入口契约
export async function replayLegged(
  store: WalletStore,
  conn: WalletConn,
  prior: TransactionHeader,
  input: { refType: string; refId: string },
  userId: number,
  currency: string,
  fingerprint: string,
  kind: 'credit' | 'refund',
  /** 已规范化的命令金额——回执与首笔同形（B12：不回读带符号腿金额，refund 腿为负） */
  commandAmount: string,
): Promise<ReplayedLegReceipt> {
  const accountId = await store.findUserAccountId(conn, userId, currency);
  const leg = accountId ? await store.findLeg(conn, prior.id, accountId) : null;
  if (!leg) {
    throw BillingErrors.business('ref_key_conflict', {
      refType: input.refType,
      refId: input.refId,
      ownerUserId: 0,
    });
  }
  assertCommandFingerprint(prior.commandFingerprint, fingerprint, {
    refType: input.refType,
    refId: input.refId,
    kind,
  });
  return {
    transactionId: prior.id,
    amount: commandAmount,
    balanceAfter: normalizeAmount(leg.balanceAfter),
    replayed: true,
  };
}
