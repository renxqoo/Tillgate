/** release / releaseExpired：冻结终态迁移——余额不动、in_flight 归还、零额审计流水 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, toStorage } from './money';
import { AuthorizationNotActiveError, AuthorizationNotFoundError } from './errors';
import { walletAccounts, walletAuthorizations, walletTransactions } from './schema';
import { lockAccount } from './account';
import { findAuthorization } from './authorizations';
import { parseRef } from './validation';
import type { ReleaseInput, ReleaseResult } from './types';
import type { Tx } from './internal';

/** 释放：取消/失败——reason 落审计行，重复释放为幂等 no-op */
export async function release(db: NodePgDatabase, input: ReleaseInput): Promise<ReleaseResult> {
  parseRef(input);
  return transitionRelease(
    db,
    input.refType,
    input.refId,
    input.reason?.slice(0, 64) ?? 'released',
    'released',
  );
}

/** 终态迁移（CAS active → terminal）：released（主动取消）/ expired（超时）共用 */
async function transitionRelease(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  reason: string,
  terminal: 'released' | 'expired',
): Promise<ReleaseResult> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(walletAuthorizations)
      .set({ status: terminal, releaseReason: reason, updatedAt: new Date() })
      .where(
        and(
          eq(walletAuthorizations.refType, refType),
          eq(walletAuthorizations.refId, refId),
          eq(walletAuthorizations.status, 'active'),
        ),
      )
      .returning({
        id: walletAuthorizations.id,
        userId: walletAuthorizations.userId,
        currency: walletAuthorizations.currency,
        amount: walletAuthorizations.amount,
      });
    if (claimed.length === 0) {
      return replayRelease(tx, refType, refId, reason);
    }
    const claim = claimed[0];
    if (!claim) throw new Error('wallet release cas returned empty');
    const account = await lockAccount(tx, claim.userId, claim.currency);
    const inFlightAfter = new Decimal(account.inFlight).minus(claim.amount);
    await tx.insert(walletTransactions).values({
      userId: claim.userId,
      currency: claim.currency,
      kind: 'release',
      refType,
      refId,
      amount: '0',
      balanceBefore: account.balance,
      balanceAfter: account.balance,
      authorizationId: claim.id,
      memo: reason,
    });
    await tx
      .update(walletAccounts)
      .set({ inFlight: toStorage(inFlightAfter), updatedAt: new Date() })
      .where(
        and(eq(walletAccounts.userId, claim.userId), eq(walletAccounts.currency, claim.currency)),
      );
    return {
      authorizationId: claim.id,
      amount: claim.amount,
      reason,
      replayed: false,
    };
  });
}

/** CAS 失败分支：已释放/已过期 → 幂等 no-op；settled → 状态机拒绝 */
async function replayRelease(
  tx: Tx,
  refType: string,
  refId: string,
  reason: string,
): Promise<ReleaseResult> {
  const auth = await findAuthorization(tx, refType, refId);
  if (!auth) throw new AuthorizationNotFoundError(refType, refId);
  if (auth.status === 'released' || auth.status === 'expired') {
    return {
      authorizationId: auth.id,
      amount: auth.amount,
      reason: auth.releaseReason ?? reason,
      replayed: true,
    };
  }
  throw new AuthorizationNotActiveError(refType, refId, auth.status);
}

/** 超时释放扫描（worker 周期调用）：expires_at 到点的 active 冻结转 expired */
export async function releaseExpired(
  db: NodePgDatabase,
  now: Date = new Date(),
  limit = 100,
): Promise<{ released: number }> {
  const expired = await db
    .select({ refType: walletAuthorizations.refType, refId: walletAuthorizations.refId })
    .from(walletAuthorizations)
    .where(
      and(
        eq(walletAuthorizations.status, 'active'),
        sql`${walletAuthorizations.expiresAt} is not null`,
        lte(walletAuthorizations.expiresAt, now),
      ),
    )
    .limit(limit);
  let released = 0;
  for (const item of expired) {
    try {
      const result = await transitionRelease(db, item.refType, item.refId, 'expired', 'expired');
      if (!result.replayed) released += 1;
    } catch (error) {
      if (!(error instanceof AuthorizationNotActiveError)) throw error;
    }
  }
  return { released };
}
