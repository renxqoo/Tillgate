/** 禁用 App:CAS 0→1,属主面不可逆(v1 disableApp) */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import type { AppRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function disableApp(
  ctx: UseCaseContext,
  input: { userId: number; appId: number },
): Promise<AppRecord> {
  const owned = await ctx.store.findOwnedApp(ctx.db, { userId: input.userId, appId: input.appId });
  if (owned === null) throw AccountsErrors.business('app_not_found', { appId: input.appId });
  if (owned.status !== 0) {
    throw AccountsErrors.business('app_already_disabled', { appId: input.appId });
  }

  return runTx(
    ctx.db,
    async (tx) => {
      const disabled = await ctx.store.disableApp(tx, { userId: input.userId, appId: input.appId });
      if (disabled === null) {
        throw AccountsErrors.business('app_already_disabled', { appId: input.appId });
      }
      return disabled;
    },
    ctx.txRetry,
  );
}
