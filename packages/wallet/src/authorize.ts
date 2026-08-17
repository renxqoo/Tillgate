/** authorize：冻结/预占——可用口径 = balance + credit_limit − in_flight；(refType, refId) 幂等 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { InsufficientBalanceError, RefKeyConflictError, WalletInternalError } from './errors';
import { walletAccounts, walletAuthorizations } from './schema';
import { lockAccounts, resolveUserAccount } from './account';
import { findAuthorization } from './authorizations';
import { isUniqueViolation, runTx } from './internal';
import { parseAmount, parseUserRef, type ValidationGuards } from './validation';
import type { AuthorizeInput, AuthorizeResult } from './types';

export async function authorize(
  db: NodePgDatabase,
  input: AuthorizeInput,
  guards?: ValidationGuards,
): Promise<AuthorizeResult> {
  const currency = parseUserRef(input, guards);
  const amount = parseAmount(input.amount);

  // 幂等快速路径：可用口径守卫之前先查既有冻结（重放不该被余额守卫误伤）
  const prior = await findAuthorization(db, input.refType, input.refId);
  if (prior) {
    const [owner] = await db
      .select({ userId: walletAccounts.userId })
      .from(walletAccounts)
      .where(eq(walletAccounts.id, prior.accountId));
    if (owner?.userId !== input.userId) {
      throw new RefKeyConflictError(input.refType, input.refId, owner?.userId ?? 0);
    }
    return {
      authorizationId: prior.id,
      amount: prior.amount,
      status: prior.status as AuthorizeResult['status'],
      expiresAt: prior.expiresAt ? prior.expiresAt.toISOString() : null,
      replayed: true,
    };
  }

  try {
    return await runTx(db, async (tx) => {
      const accountId = await resolveUserAccount(tx, input.userId, currency);
      const accounts = await lockAccounts(tx, [accountId]);
      const account = accounts.get(accountId)!;
      const inFlight = new Decimal(account.inFlight);
      const available = new Decimal(account.balance)
        .plus(account.creditLimit)
        .minus(inFlight);
      if (available.lt(amount)) {
        throw new InsufficientBalanceError(
          input.userId,
          toStorage(available),
          toStorage(amount),
          currency,
        );
      }
      const [auth] = await tx
        .insert(walletAuthorizations)
        .values({
          accountId,
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount),
          status: 'active',
          expiresAt: input.expiresAt ?? null,
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
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findAuthorization(db, input.refType, input.refId);
      if (existing) {
        // 幂等键归属校验：同键跨账户顶撞必须炸，不能把别人的冻结当自己的重放
        const owner = await db
          .select({ userId: walletAccounts.userId })
          .from(walletAccounts)
          .where(eq(walletAccounts.id, existing.accountId));
        if (owner[0]?.userId !== input.userId) {
          throw new RefKeyConflictError(input.refType, input.refId, owner[0]?.userId ?? 0);
        }
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
