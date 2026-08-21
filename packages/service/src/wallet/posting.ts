/**
 * wallet 用例的私有编排件：账户锁定（冻结拒绝）+ 过账执行。
 * 顺序不变量：先锁全部涉及账户（id 定序防死锁；冻结即拒）→ 结构校验（真实锁集）
 * → 落批头 → 逐腿链式推进余额。腿的定律在 @ai-gateway/domain 的 posting（纯函数）。
 */
import type { Db, DbTx } from '@ai-gateway/repository';
import type { RepoContext } from '@ai-gateway/repository';
import type { Repositories } from '@ai-gateway/repository';
import { FrozenAccountError, WalletInvariantError } from '@ai-gateway/domain';
import { legBalanceAfter, validatePosting, type PostingSpec } from '@ai-gateway/domain';

import type { AccountRow } from '@ai-gateway/repository';

/** 定序锁定 + 冻结账户拒绝（整个事务回滚） */
export async function lockActiveAccounts(
  repos: Repositories,
  c: RepoContext,
  accountIds: readonly string[],
): Promise<Map<string, AccountRow>> {
  const rows = await repos.wallet.lockAccounts(c, accountIds);
  const map = new Map<string, AccountRow>();
  for (const row of rows) {
    if (row.status === 'frozen') throw new FrozenAccountError(row.id);
    map.set(row.id, row);
  }
  return map;
}

export interface PostedReceipt {
  transactionId: number;
  /** accountId → balanceAfter */
  balanceAfter: ReadonlyMap<string, string>;
}

/** 过账：锁 → 结构校验 → 批头 → 逐腿（before/after 链式推进账户余额） */
export async function post(
  repos: Repositories,
  c: RepoContext,
  spec: PostingSpec,
): Promise<PostedReceipt> {
  const locked = await lockActiveAccounts(repos, c, spec.legs.map((leg) => leg.accountId));
  validatePosting(spec, new Set(locked.keys()));
  const transactionId = await repos.wallet.insertTransaction(c, {
    kind: spec.kind,
    refType: spec.refType,
    refId: spec.refId,
    memo: spec.memo ?? null,
    creditLimitAfter: spec.creditLimitAfter ?? null,
    frozenAfter: spec.frozenAfter ?? null,
    commandFingerprint: spec.commandFingerprint,
  });
  const balanceAfter = new Map<string, string>();
  for (const leg of spec.legs) {
    const account = locked.get(leg.accountId);
    if (!account) throw new WalletInvariantError(`posting: account ${leg.accountId} not locked`);
    const after = legBalanceAfter(account.balance, leg.amount);
    await repos.wallet.applyLeg(c, {
      transactionId,
      accountId: leg.accountId,
      currency: leg.currency,
      amount: leg.amount.toString(),
      balanceBefore: account.balance,
      balanceAfter: after,
    });
    balanceAfter.set(leg.accountId, after);
  }
  return { transactionId, balanceAfter };
}

/**
 * 事务策略：injected 存在则加入调用方事务（§4 补充授权等跨动词组事务），
 * 否则用例自开事务。返回值原样透传。
 */
export function withTx<T>(
  db: Db,
  injected: DbTx | undefined,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (injected) return fn(injected);
  return db.transaction(fn);
}
