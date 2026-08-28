/** 属主吊销 Key:CAS 0→1 + revokedAt(存储时钟);不可逆 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import type { ApiKeyRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function revokeKey(
  ctx: UseCaseContext,
  input: { userId: number; keyId: number },
): Promise<ApiKeyRecord> {
  const owned = await ctx.store.findOwnedKey(ctx.db, { userId: input.userId, keyId: input.keyId });
  if (owned === null) throw AccountsErrors.business('key_not_found', { keyId: input.keyId });
  if (owned.status !== 0) {
    throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });
  }

  return runTx(
    ctx.db,
    async (tx) => {
      const revoked = await ctx.store.revokeKey(tx, { userId: input.userId, keyId: input.keyId });
      if (revoked === null) {
        throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });
      }
      return revoked;
    },
    ctx.txRetry,
  );
}
