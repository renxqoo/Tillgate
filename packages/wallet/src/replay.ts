/** 幂等重放：并发同键被唯一索引拦下后，读回首笔交易及其腿（含归属校验） */
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeAmount } from './money';
import { RefKeyConflictError, WalletInternalError } from './errors';
import { walletAccounts, walletLegs, walletTransactions } from './schema';
import { resolveAccount } from './account';
import type { CreditLineResult, CreditResult, TransferResult } from './types';

/** 幂等快速路径：该 (ref, kind) 是否已有交易——守卫前先查，重放不依赖唯一索引兜底 */
export async function hasTransaction(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  kind: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.refType, refType),
        eq(walletTransactions.refId, refId),
        eq(walletTransactions.kind, kind),
      ),
    );
  return row !== undefined;
}

/** 读回交易头 + 腿 + 腿的账户归属 */
async function loadTransaction(db: NodePgDatabase, refType: string, refId: string, kind: string) {
  const [header] = await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.refType, refType),
        eq(walletTransactions.refId, refId),
        eq(walletTransactions.kind, kind),
      ),
    );
  if (!header) throw new WalletInternalError('replay.header_missing', `${kind} ${refType}/${refId}`);
  const legs = await db
    .select({
      accountId: walletLegs.accountId,
      amount: walletLegs.amount,
      balanceAfter: walletLegs.balanceAfter,
      userId: walletAccounts.userId,
      currency: walletAccounts.currency,
    })
    .from(walletLegs)
    .innerJoin(walletAccounts, eq(walletAccounts.id, walletLegs.accountId))
    .where(eq(walletLegs.transactionId, header.id));
  return { header, legs };
}

/** credit/refund 重放：找期望用户账户上的那条腿 */
export async function replayLegged(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  kind: 'credit' | 'refund',
  expectedUserId: number,
  expectedCurrency: string,
): Promise<CreditResult> {
  const { header, legs } = await loadTransaction(db, refType, refId, kind);
  const own = legs.find(
    (leg) => leg.userId === expectedUserId && leg.currency === expectedCurrency,
  );
  if (!own) {
    // 键被他人占用（跨账户/跨币种顶撞）——必须炸而不是串号
    const ownerLeg = legs.find((leg) => leg.userId !== null);
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  return {
    transactionId: header.id,
    amount: normalizeAmount(own.amount.replace('-', '')),
    balanceAfter: normalizeAmount(own.balanceAfter),
    replayed: true,
  };
}

/** transfer 重放：from/to 各找一条腿（按解析后的账户 id 对齐） */
export async function replayTransfer(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  from: { userId?: number; code?: string },
  to: { userId?: number; code?: string },
): Promise<TransferResult> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'transfer');
  const legsByAccount = new Map(legs.map((leg) => [leg.accountId, leg]));
  const fromCurrency = await accountCurrency(db, from, legs);
  const toCurrency = await accountCurrency(db, to, legs);
  const fromId = await resolveAccount(db, from, fromCurrency);
  const toId = await resolveAccount(db, to, toCurrency);
  const fromLeg = legsByAccount.get(fromId);
  const toLeg = legsByAccount.get(toId);
  if (!fromLeg || !toLeg) {
    const ownerLeg = legs[0];
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  return {
    transactionId: header.id,
    amount: normalizeAmount(toLeg.amount.replace('-', '')),
    fromBalanceAfter: normalizeAmount(fromLeg.balanceAfter),
    toBalanceAfter: normalizeAmount(toLeg.balanceAfter),
    replayed: true,
  };
}

/** 从腿的币种推断账户币种（重放路径无需再传 currency） */
async function accountCurrency(
  db: NodePgDatabase,
  ref: { userId?: number; code?: string },
  legs: Array<{ userId: number | null; currency: string }>,
): Promise<string> {
  if (typeof ref.userId === 'number') {
    const hit = legs.find((leg) => leg.userId === ref.userId);
    return hit?.currency ?? 'CNY';
  }
  const [row] = await db
    .select({ currency: walletAccounts.currency })
    .from(walletAccounts)
    .where(and(eq(walletAccounts.kind, 'internal'), eq(walletAccounts.code, ref.code ?? 'outside')))
    .limit(1);
  return row?.currency ?? legs[0]?.currency ?? 'CNY';
}

/** credit_line 重放：读回首笔的授信结果（零额腿只做归属校验） */
export async function replayCreditLine(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  expectedUserId: number,
  expectedCurrency: string,
): Promise<CreditLineResult> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'credit_line');
  const own = legs.find(
    (leg) => leg.userId === expectedUserId && leg.currency === expectedCurrency,
  );
  if (!own) {
    const ownerLeg = legs.find((leg) => leg.userId !== null);
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  return {
    transactionId: header.id,
    creditLimit: normalizeAmount(header.creditLimitAfter ?? '0'),
    replayed: true,
  };
}

/** freeze 重放：读回首笔状态（腿的账户即目标） */
export async function replayFreeze(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  accountId: string,
): Promise<{ transactionId: number; frozen: boolean; replayed: boolean }> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'freeze');
  if (!legs.some((leg) => leg.accountId === accountId)) {
    const ownerLeg = legs.find((leg) => leg.userId !== null);
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  const [account] = await db
    .select({ status: walletAccounts.status })
    .from(walletAccounts)
    .where(inArray(walletAccounts.id, [accountId]));
  return {
    transactionId: header.id,
    frozen: account?.status === 'frozen',
    replayed: true,
  };
}
