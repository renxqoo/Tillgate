/** release / releaseExpired：冻结终态迁移——余额不动、in_flight 归还。
 *  复式模型下释放不落交易（零额噪声行取消）——审计在 authorizations 单据本身
 *  （status + release_reason + updated_at）；release 支持 tx 注入加入调用方事务。 */
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  InvalidInputError,
  WalletInternalError,
} from './errors';
import { walletAccounts, walletAuthorizations } from './schema';
import { lockAccounts } from './account';
import { findAuthorization } from './authorizations';
import { parseRef, type ValidationGuards } from './validation';
import type { ReleaseInput, ReleaseResult } from './types';
import { runTx, type DbLike, type Tx } from './internal';
import { assertOptionalString } from './validation';
import type { WalletTelemetry } from './types';
import { assertCommandFingerprint, commandFingerprint } from './idempotency';

/** 释放：取消/失败——重复释放为幂等 no-op */
export async function release(
  db: NodePgDatabase,
  input: ReleaseInput,
  guards?: ValidationGuards,
): Promise<ReleaseResult> {
  parseRef(input, guards);
  assertOptionalString(input.reason, 'reason', 64);
  const reason = input.reason ?? 'released';
  const fingerprint = commandFingerprint('release', { reason });
  return transitionRelease(
    input.tx ?? db,
    input.refType,
    input.refId,
    reason,
    'released',
    guards?.telemetry,
    fingerprint,
  );
}

/** 终态迁移（CAS active → terminal）：released（主动取消）/ expired（超时）共用 */
async function transitionRelease(
  db: DbLike,
  refType: string,
  refId: string,
  reason: string,
  terminal: 'released' | 'expired',
  telemetry?: WalletTelemetry,
  fingerprint?: string,
): Promise<ReleaseResult> {
  return runTx(
    db,
    async (tx) => {
      const claimed = await tx
        .update(walletAuthorizations)
        .set({
          status: terminal,
          releaseReason: reason,
          releaseFingerprint: terminal === 'released' ? fingerprint : null,
          updatedAt: new Date(),
        })
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
        return replayRelease(tx, refType, refId, reason, fingerprint);
      }
      const claim = claimed[0];
      if (!claim) throw new WalletInternalError('release.cas_empty');
      const account = (await lockAccounts(tx, [claim.accountId], { allowFrozen: true })).get(
        claim.accountId,
      )!;
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
    },
    telemetry,
    terminal === 'expired' ? 'releaseExpired' : 'release',
  );
}

/** CAS 失败分支：已释放/已过期 → 幂等 no-op；settled → 状态机拒绝 */
async function replayRelease(
  tx: Tx,
  refType: string,
  refId: string,
  reason: string,
  expectedFingerprint?: string,
): Promise<ReleaseResult> {
  const auth = await findAuthorization(tx, refType, refId);
  if (!auth) throw new AuthorizationNotFoundError(refType, refId);
  if (auth.status === 'released' || auth.status === 'expired') {
    if (auth.status === 'released' && expectedFingerprint) {
      assertCommandFingerprint(
        auth.releaseFingerprint,
        expectedFingerprint,
        refType,
        refId,
        'release',
      );
    }
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
  limit = 100,
  telemetry?: WalletTelemetry,
): Promise<{ released: number }> {
  return scanExpired(db, undefined, limit, telemetry);
}

/** 测试专用确定性时钟入口；生产维护入口必须使用数据库时钟。 */
export async function releaseExpiredAt(
  db: NodePgDatabase,
  now: Date,
  limit = 100,
  telemetry?: WalletTelemetry,
): Promise<{ released: number }> {
  return scanExpired(db, now, limit, telemetry);
}

async function scanExpired(
  db: NodePgDatabase,
  now: Date | undefined,
  limit: number,
  telemetry?: WalletTelemetry,
): Promise<{ released: number }> {
  if (now !== undefined && (!(now instanceof Date) || !Number.isFinite(now.getTime()))) {
    throw new InvalidInputError('now', 'must be a valid Date');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new InvalidInputError('limit', 'must be an integer between 1 and 1000');
  }

  return runTx(
    db,
    async (tx) => {
      const expiryCondition =
        now === undefined
          ? sql`${walletAuthorizations.expiresAt} <= now()`
          : lte(walletAuthorizations.expiresAt, now);
      const expired = await tx
        .select({
          id: walletAuthorizations.id,
          accountId: walletAuthorizations.accountId,
          amount: walletAuthorizations.amount,
        })
        .from(walletAuthorizations)
        .where(
          and(
            eq(walletAuthorizations.status, 'active'),
            sql`${walletAuthorizations.expiresAt} is not null`,
            expiryCondition,
          ),
        )
        .orderBy(asc(walletAuthorizations.expiresAt), asc(walletAuthorizations.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (expired.length === 0) return { released: 0 };

      const locked = await lockAccounts(
        tx,
        expired.map((item) => item.accountId),
        { allowFrozen: true },
      );
      const releasedByAccount = new Map<string, Decimal>();
      for (const item of expired) {
        releasedByAccount.set(
          item.accountId,
          (releasedByAccount.get(item.accountId) ?? new Decimal(0)).plus(item.amount),
        );
      }
      await tx
        .update(walletAuthorizations)
        .set({ status: 'expired', releaseReason: 'expired', updatedAt: now ?? new Date() })
        .where(
          and(
            inArray(
              walletAuthorizations.id,
              expired.map((item) => item.id),
            ),
            eq(walletAuthorizations.status, 'active'),
          ),
        );
      for (const [accountId, releasedAmount] of releasedByAccount) {
        const account = locked.get(accountId);
        if (!account) throw new WalletInternalError('release_expired.account_missing', accountId);
        await tx
          .update(walletAccounts)
          .set({
            inFlight: toStorage(new Decimal(account.inFlight).minus(releasedAmount)),
            updatedAt: now ?? new Date(),
          })
          .where(eq(walletAccounts.id, accountId));
      }
      return { released: expired.length };
    },
    telemetry,
    'releaseExpired',
  );
}
