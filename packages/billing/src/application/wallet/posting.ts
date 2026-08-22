/**
 * wallet 动词的私有编排件：账户锁定（冻结拒绝）+ 过账执行 + 事务策略。
 * 顺序不变量：先锁全部涉及账户（id 定序防死锁；冻结即拒）→ 结构校验（真实锁集）
 * → 落批头 → 逐腿链式推进余额。腿的定律在 domain/wallet/posting（纯函数）。
 */
import { DefectError } from '@tokenlens/errors';
import { BillingErrors } from '../../domain/errors.js';
import { legBalanceAfter, validatePosting, type PostingSpec } from '../../domain/wallet/posting.js';
import type { AccountSnapshot } from '../../domain/wallet/accounts.js';
import type { WalletStore, WalletTx } from '../../ports/wallet-store.js';

/** 定序锁定 + 冻结账户拒绝（整个事务回滚） */
export async function lockActiveAccounts(
  store: WalletStore,
  conn: WalletTx,
  accountIds: readonly string[],
): Promise<Map<string, AccountSnapshot>> {
  const rows = await store.lockAccounts(conn, accountIds);
  const map = new Map<string, AccountSnapshot>();
  for (const row of rows) {
    if (row.status === 'frozen') {
      throw BillingErrors.business('account_frozen', { accountId: row.id });
    }
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
  store: WalletStore,
  conn: WalletTx,
  spec: PostingSpec,
): Promise<PostedReceipt> {
  const locked = await lockActiveAccounts(
    store,
    conn,
    spec.legs.map((leg) => leg.accountId),
  );
  validatePosting(spec, new Set(locked.keys()));
  const transactionId = await store.insertTransaction(conn, {
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
    if (!account) {
      // validatePosting 已保证锁集覆盖全部腿——不可达分支红灯
      throw new DefectError(
        `posting: account ${leg.accountId} not locked`,
        'billing.wallet_invariant',
      );
    }
    const after = legBalanceAfter(account.balance, leg.amount);
    await store.applyLeg(conn, {
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
 * 事务策略：上层注入 tx 则加入其事务（SAVEPOINT 隔离 + 瞬态重试——失败不毒化外层），
 * 否则动词自开事务。
 */
export function withTx<T>(
  store: WalletStore,
  injected: WalletTx | undefined,
  fn: (tx: WalletTx) => Promise<T>,
): Promise<T> {
  return injected ? store.joinTransaction(injected, fn) : store.transaction(fn);
}
