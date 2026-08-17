/** authorize：冻结/预占——可用口径 = balance − in_flight；(refType, refId) 幂等 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Decimal, normalizeAmount, toStorage } from './money';
import { InsufficientBalanceError } from './errors';
import { walletAccounts, walletAuthorizations } from './schema';
import { lockAccount } from './account';
import { findAuthorization } from './authorizations';
import { isUniqueViolation } from './internal';
import { parseAmount, parseUserRef } from './validation';
import type { AuthorizeInput, AuthorizeResult } from './types';

export async function authorize(
  db: NodePgDatabase,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  parseUserRef(input);
  const amount = parseAmount(input.amount);

  try {
    return await db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.userId);
      const inFlight = new Decimal(account.inFlight);
      const available = new Decimal(account.balance).minus(inFlight);
      if (available.lt(amount)) {
        throw new InsufficientBalanceError(
          input.userId,
          toStorage(available),
          toStorage(amount),
        );
      }
      const [auth] = await tx
        .insert(walletAuthorizations)
        .values({
          userId: input.userId,
          refType: input.refType,
          refId: input.refId,
          amount: toStorage(amount),
          status: 'active',
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: walletAuthorizations.id });
      if (!auth) throw new Error('wallet authorize insert failed');
      await tx
        .update(walletAccounts)
        .set({ inFlight: toStorage(inFlight.plus(amount)), updatedAt: new Date() })
        .where(eq(walletAccounts.userId, input.userId));
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
