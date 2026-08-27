/**
 * 轮换 App 密钥:实现层 FOR UPDATE 行锁防并发轮换孤儿化;
 * 新明文仅本用例返回一次。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { generateAppCredentials, sha256Hex } from '../domain/credentials.js';
import type { AppRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function rotateAppSecret(
  ctx: UseCaseContext,
  input: { userId: number; appId: number },
): Promise<{ app: AppRecord; clientSecret: string }> {
  const owned = await ctx.store.findOwnedApp(ctx.db, { userId: input.userId, appId: input.appId });
  if (owned === null) throw AccountsErrors.business('app_not_found', { appId: input.appId });
  if (owned.status !== 0) {
    throw AccountsErrors.business('app_already_disabled', { appId: input.appId });
  }

  const { clientSecret } = generateAppCredentials();
  const app = await runTx(
    ctx.db,
    async (tx) => {
      const rotated = await ctx.store.rotateAppSecret(tx, {
        userId: input.userId,
        appId: input.appId,
        clientSecretHash: sha256Hex(clientSecret),
      });
      if (rotated === null) {
        throw AccountsErrors.business('app_already_disabled', { appId: input.appId });
      }
      return rotated;
    },
    ctx.txRetry,
  );
  return { app, clientSecret };
}
