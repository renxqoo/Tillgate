/** authorize：冻结/预占——可用口径 = balance + credit_limit − in_flight（allowCredit:false
 *  时为现金口径 balance − in_flight）；(refType, refId) 幂等；tx 注入加入调用方事务 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { RefKeyConflictError, WalletInternalError } from './errors';
import { walletAccounts, walletAuthorizations } from './schema';
import { lockAccounts, resolveUserAccount } from './account';
import { findAuthorization } from './authorizations';
import { isUniqueViolation, runTx, type DbLike } from './internal';
import { assertOptionalDate, parseAmount, parseUserRef, type ValidationGuards } from './validation';
import type { AuthorizeInput, AuthorizeResult } from './types';
import { assertCanDebit } from './exposure';
import { assertCommandFingerprint, commandFingerprint } from './idempotency';

export async function authorize(
  db: NodePgDatabase,
  input: AuthorizeInput,
  guards?: ValidationGuards,
): Promise<AuthorizeResult> {
  const currency = parseUserRef(input, guards);
  assertOptionalDate(input.expiresAt, 'expiresAt');
  const amount = parseAmount(input.amount);
  const fingerprint = commandFingerprint('authorize', {
    userId: input.userId,
    currency,
    amount: normalizeAmount(input.amount),
    expiresAt: input.expiresAt?.toISOString() ?? null,
    // 只在显式 false 时进指纹：缺省调用与历史指纹字节一致（部署零漂移）；
    // true 与缺省语义等价，不必区分
    allowCredit: input.allowCredit === false ? false : undefined,
    memo: input.memo ?? null,
  });
  // tx 注入时所有读写走调用方事务（含快速路径——须读到调用方未提交的前序变动）
  const conn: DbLike = input.tx ?? db;

  // 幂等快速路径：可用口径守卫之前先查既有冻结（重放不该被余额守卫误伤）
  const prior = await findAuthorization(conn, input.refType, input.refId);
  if (prior) {
    const [owner] = await conn
      .select({ userId: walletAccounts.userId, currency: walletAccounts.currency })
      .from(walletAccounts)
      .where(eq(walletAccounts.id, prior.accountId));
    if (owner?.userId !== input.userId || owner.currency !== currency) {
      throw new RefKeyConflictError(input.refType, input.refId, owner?.userId ?? 0);
    }
    assertCommandFingerprint(
      prior.authorizeFingerprint,
      fingerprint,
      input.refType,
      input.refId,
      'authorize',
    );
    return {
      authorizationId: prior.id,
      amount: prior.amount,
      status: prior.status as AuthorizeResult['status'],
      expiresAt: prior.expiresAt ? prior.expiresAt.toISOString() : null,
      replayed: true,
    };
  }

  try {
    return await runTx(
      conn,
      async (tx) => {
        const accountId = await resolveUserAccount(tx, input.userId, currency);
        const accounts = await lockAccounts(tx, [accountId]);
        const account = accounts.get(accountId)!;
        const inFlight = new Decimal(account.inFlight);
        assertCanDebit(account, amount, input.userId, { allowCredit: input.allowCredit });
        const [auth] = await tx
          .insert(walletAuthorizations)
          .values({
            accountId,
            refType: input.refType,
            refId: input.refId,
            amount: toStorage(amount),
            status: 'active',
            expiresAt: input.expiresAt ?? null,
            memo: input.memo,
            authorizeFingerprint: fingerprint,
          })
          .returning({ id: walletAuthorizations.id });
        if (!auth) throw new WalletInternalError('authorize.insert');
        await tx
          .update(walletAccounts)
          .set({ inFlight: toStorage(inFlight.plus(amount)), updatedAt: new Date() })
          .where(eq(walletAccounts.id, accountId));
        return {
          authorizationId: auth.id,
          amount: normalizeAmount(input.amount),
          status: 'active',
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          replayed: false,
        };
      },
      guards?.telemetry,
      'authorize',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findAuthorization(conn, input.refType, input.refId);
      if (existing) {
        // 幂等键归属校验：同键跨账户顶撞必须炸，不能把别人的冻结当自己的重放
        const owner = await conn
          .select({ userId: walletAccounts.userId, currency: walletAccounts.currency })
          .from(walletAccounts)
          .where(eq(walletAccounts.id, existing.accountId));
        if (owner[0]?.userId !== input.userId || owner[0]?.currency !== currency) {
          throw new RefKeyConflictError(input.refType, input.refId, owner[0]?.userId ?? 0);
        }
        assertCommandFingerprint(
          existing.authorizeFingerprint,
          fingerprint,
          input.refType,
          input.refId,
          'authorize',
        );
        return {
          authorizationId: existing.id,
          amount: existing.amount,
          status: existing.status as AuthorizeResult['status'],
          expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : null,
          replayed: true,
        };
      }
    }
    throw error;
  }
}
