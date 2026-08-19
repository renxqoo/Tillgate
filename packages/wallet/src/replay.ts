/** 幂等重放：并发同键被唯一索引拦下后，读回首笔交易及其腿（含归属校验） */
import { and, eq } from 'drizzle-orm';
import type { DbLike } from './internal';
import { Decimal, normalizeAmount } from './money';
import { RefKeyConflictError, WalletInternalError } from './errors';
import { walletAccounts, walletLegs, walletTransactions } from './schema';
import type { CreditLineResult, CreditResult, TransferResult } from './types';
import { assertCommandFingerprint } from './idempotency';

function matchesAccountLeg(
  leg: { accountKind: string; userId: number | null; code: string | null; currency: string },
  ref: { userId?: number; code?: string },
  currency: string,
): boolean {
  return (
    leg.currency === currency &&
    (typeof ref.userId === 'number'
      ? leg.accountKind === 'user' && leg.userId === ref.userId
      : leg.accountKind === 'internal' && leg.code === ref.code)
  );
}

/** 幂等快速路径：该 (ref, kind) 是否已有交易——守卫前先查，重放不依赖唯一索引兜底 */
export async function hasTransaction(
  db: DbLike,
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
async function loadTransaction(db: DbLike, refType: string, refId: string, kind: string) {
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
  if (!header)
    throw new WalletInternalError('replay.header_missing', `${kind} ${refType}/${refId}`);
  const legs = await db
    .select({
      accountId: walletLegs.accountId,
      amount: walletLegs.amount,
      balanceAfter: walletLegs.balanceAfter,
      accountKind: walletAccounts.kind,
      userId: walletAccounts.userId,
      code: walletAccounts.code,
      currency: walletAccounts.currency,
    })
    .from(walletLegs)
    .innerJoin(walletAccounts, eq(walletAccounts.id, walletLegs.accountId))
    .where(eq(walletLegs.transactionId, header.id));
  return { header, legs };
}

/** credit/refund 重放：找期望用户账户上的那条腿 */
export async function replayLegged(
  db: DbLike,
  refType: string,
  refId: string,
  kind: 'credit' | 'refund',
  expectedUserId: number,
  expectedCurrency: string,
  expectedFingerprint: string,
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
  assertCommandFingerprint(
    header.commandFingerprint,
    expectedFingerprint,
    refType,
    refId,
    kind,
  );
  return {
    transactionId: header.id,
    amount: normalizeAmount(own.amount.replace('-', '')),
    balanceAfter: normalizeAmount(own.balanceAfter),
    replayed: true,
  };
}

/** transfer 重放：from/to 各找一条腿（按解析后的账户 id 对齐） */
export async function replayTransfer(
  db: DbLike,
  refType: string,
  refId: string,
  from: { userId?: number; code?: string },
  to: { userId?: number; code?: string },
  fromCurrency: string,
  toCurrency: string,
  expectedFingerprint: string,
): Promise<TransferResult> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'transfer');
  const fromLegs = legs.filter((leg) => matchesAccountLeg(leg, from, fromCurrency));
  const toLegs = legs.filter((leg) => matchesAccountLeg(leg, to, toCurrency));
  const debited = fromLegs.reduce((total, leg) => total.minus(leg.amount), new Decimal(0));
  const credited = toLegs.reduce((total, leg) => total.plus(leg.amount), new Decimal(0));
  if (fromLegs.length === 0 || toLegs.length === 0 || !debited.gt(0) || !credited.eq(debited)) {
    const ownerLeg = legs[0];
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  assertCommandFingerprint(
    header.commandFingerprint,
    expectedFingerprint,
    refType,
    refId,
    'transfer',
  );
  return {
    transactionId: header.id,
    amount: normalizeAmount(credited.toString()),
    fromBalanceAfter: normalizeAmount(
      fromLegs.reduce((total, leg) => total.plus(leg.balanceAfter), new Decimal(0)).toString(),
    ),
    toBalanceAfter: normalizeAmount(
      toLegs.reduce((total, leg) => total.plus(leg.balanceAfter), new Decimal(0)).toString(),
    ),
    replayed: true,
  };
}

/** credit_line 重放：读回首笔的授信结果（零额腿只做归属校验） */
export async function replayCreditLine(
  db: DbLike,
  refType: string,
  refId: string,
  expectedUserId: number,
  expectedCurrency: string,
  expectedFingerprint: string,
): Promise<CreditLineResult> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'credit_line');
  const own = legs.find(
    (leg) => leg.userId === expectedUserId && leg.currency === expectedCurrency,
  );
  if (!own) {
    const ownerLeg = legs.find((leg) => leg.userId !== null);
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  assertCommandFingerprint(
    header.commandFingerprint,
    expectedFingerprint,
    refType,
    refId,
    'credit_line',
  );
  return {
    transactionId: header.id,
    creditLimit: normalizeAmount(header.creditLimitAfter ?? '0'),
    replayed: true,
  };
}

/** freeze 重放：读回首笔状态（腿的账户即目标） */
export async function replayFreeze(
  db: DbLike,
  refType: string,
  refId: string,
  accountId: string | undefined,
  expectedFingerprint: string,
): Promise<{ transactionId: number; frozen: boolean; replayed: boolean }> {
  const { header, legs } = await loadTransaction(db, refType, refId, 'freeze');
  if (!legs.some((leg) => leg.accountId === accountId)) {
    const ownerLeg = legs.find((leg) => leg.userId !== null);
    throw new RefKeyConflictError(refType, refId, ownerLeg?.userId ?? 0);
  }
  assertCommandFingerprint(
    header.commandFingerprint,
    expectedFingerprint,
    refType,
    refId,
    'freeze',
  );
  if (header.frozenAfter === null) {
    throw new WalletInternalError('replay.freeze_receipt_missing', `${refType}/${refId}`);
  }
  return {
    transactionId: header.id,
    frozen: header.frozenAfter,
    replayed: true,
  };
}
