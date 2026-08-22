/**
 * 创建 Application(v1 apps.service create):凭证材料生成(appId/clientId/secret)
 * + 订阅守卫(与 Key 同口径)。clientSecret 明文仅本用例返回一次。
 */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import { clampOptionalText, normalizeName } from '../domain/fields.js';
import { validateAppScope, type AppScope } from '../domain/app.js';
import { generateAppCredentials } from '../domain/credentials.js';
import type { AppRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export interface CreateAppResult {
  readonly app: AppRecord;
  readonly clientSecret: string;
}

export async function createApp(
  ctx: UseCaseContext,
  input: {
    userId: number;
    name: string;
    description?: string | null;
    scope?: AppScope | null;
    subscriptionId?: number | null;
  },
): Promise<CreateAppResult> {
  const name = normalizeName(input.name);
  if (name === null) throw AccountsErrors.business('app_patch_invalid', { field: 'name' });
  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    const d = clampOptionalText(input.description, 255);
    if (d === null) throw AccountsErrors.business('app_patch_invalid', { field: 'description' });
    description = d;
  } else if (input.description === null) {
    description = null;
  }
  if (input.scope !== undefined && input.scope !== null) {
    const invalid = validateAppScope(input.scope, {
      rpmLimitMax: ctx.policy.rpmLimitMax,
      tpmLimitMax: ctx.policy.tpmLimitMax,
      scopeModelsMax: ctx.policy.scopeModelsMax,
    });
    if (invalid !== null) throw AccountsErrors.business('app_scope_invalid', { fields: invalid });
  }
  if (input.subscriptionId !== undefined && input.subscriptionId !== null) {
    const usable = await ctx.store.findUsableSubscription(ctx.db, {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
    });
    if (usable === null) {
      throw AccountsErrors.business('subscription_not_usable', { subscriptionId: input.subscriptionId });
    }
  }

  const creds = generateAppCredentials();
  const app = await runTx(
    ctx.db,
    (tx) =>
      ctx.store.insertApp(tx, {
        appId: creds.appId,
        userId: input.userId,
        clientId: creds.clientId,
        clientSecretHash: creds.clientSecretHash,
        name,
        description: description ?? null,
        subscriptionId: input.subscriptionId ?? null,
        scope: input.scope ?? null,
      }),
    ctx.txRetry,
  );
  return { app, clientSecret: creds.clientSecret };
}
