/** release / releaseExpired：冻结终态迁移——余额不动、in_flight 归还。
 *  复式模型下释放不落交易（零额噪声行取消）——审计在 authorizations 单据本身
 *  （status + release_reason + updated_at）。 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  FrozenAccountError,
  WalletInternalError,
} from './errors';
import { walletAccounts, walletAuthorizations } from './schema';
import { lockAccounts } from './account';
import { findAuthorization } from './authorizations';
import { parseRef } from './validation';
import type { ReleaseInput, ReleaseResult } from './types';
import { runTx, type Tx } from './internal';

/** 释放：取消/失败——重复释放为幂等 no-op */
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
  return runTx(db, async (tx) => {
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
        accountId: walletAuthorizations.accountId,
        amount: walletAuthorizations.amount,
      });
    if (claimed.length === 0) {
      return replayRelease(tx, refType, refId, reason);
    }
    const claim = claimed[0];
    if (!claim) throw new WalletInternalError('release.cas_empty');
    const account = (await lockAccounts(tx, [claim.accountId])).get(claim.accountId)!;
    const inFlightAfter = new Decimal(account.inFlight).minus(claim.amount);
    await tx
      .update(walletAccounts)
      .set({ inFlight: toStorage(inFlightAfter), updatedAt: new Date() })
      .where(eq(walletAccounts.id, claim.accountId));
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
      // 状态已被他路迁移 → 跳过；账户风控冻结 → 留待解冻后下轮处理（不得中断整轮扫描）
      if (error instanceof AuthorizationNotActiveError || error instanceof FrozenAccountError) {
        continue;
      }
      throw error;
    }
  }
  return { released };
}
