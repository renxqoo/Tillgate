/**
 * 管理面 Key 补丁:不限属主;status 仅 {0,1}(管理面可吊销/恢复);
 * 投影不返回 keyHash;审计 api_key.update 同事务。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import type { AdminApiKeyPatch, ApiKeyRecord } from '../ports/account-store.js';
import { parseKeyFields, type KeyFieldsInput } from './key-fields.js';
import type { UseCaseContext } from './context.js';

export async function adminPatchKey(
  ctx: UseCaseContext,
  input: { keyId: number; patch: KeyFieldsInput & { status?: number }; adminId: number },
): Promise<ApiKeyRecord> {
  const { status, ...fields } = input.patch;
  if (status !== undefined && !([0, 1] as const).includes(status as 0 | 1)) {
    throw AccountsErrors.business('key_patch_invalid', { field: 'status', value: status });
  }
  const patch: AdminApiKeyPatch = {
    ...parseKeyFields(fields, ctx.policy, ctx.now()),
    ...(status !== undefined ? { status } : {}),
  };

  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.adminPatchKey(tx, { keyId: input.keyId, patch });
      if (updated === null) throw AccountsErrors.business('key_not_found', { keyId: input.keyId });
      await ctx.audit.record(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'api_key.update',
        targetType: 'api_key',
        targetId: String(input.keyId),
        detail: { patch: input.patch },
      });
      return updated;
    },
    ctx.txRetry,
  );
}
