/** 自助改显示名:trim 后 1..64(v1 PATCH /v1/me/display-name) */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import { normalizeName } from '../domain/fields.js';
import type { UserRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function updateDisplayName(
  ctx: UseCaseContext,
  input: { userId: number; displayName: string },
): Promise<UserRecord> {
  const displayName = normalizeName(input.displayName);
  if (displayName === null) {
    throw AccountsErrors.business('display_name_invalid');
  }
  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.updateUser(tx, {
        userId: input.userId,
        patch: { displayName },
        advanceSessionAnchor: false,
      });
      if (updated === null) throw AccountsErrors.business('user_not_found', { userId: input.userId });
      return updated;
    },
    ctx.txRetry,
  );
}
