/**
 * 属主修改 Key(name/remark/限额/过期;v1 patchKey)。
 * 越权与不存在统一 not_found;已吊销冲突;CAS 0 行竞态按已吊销判别。
 */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import type { ApiKeyRecord } from '../ports/account-store.js';
import { parseKeyFields, type KeyFieldsInput } from './key-fields.js';
import type { UseCaseContext } from './context.js';

export async function patchKey(
  ctx: UseCaseContext,
  input: { userId: number; keyId: number; patch: KeyFieldsInput },
): Promise<ApiKeyRecord> {
  const patch = parseKeyFields(input.patch, ctx.policy, ctx.now());
  const owned = await ctx.store.findOwnedKey(ctx.db, { userId: input.userId, keyId: input.keyId });
  if (owned === null) throw AccountsErrors.business('key_not_found', { keyId: input.keyId });
  if (owned.status !== 0) throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });

  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.patchKey(tx, {
        userId: input.userId,
        keyId: input.keyId,
        patch,
      });
      if (updated === null) {
        // CAS 0 行:与吊销并发——按已吊销语义表达(v1 409)
        throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });
      }
      return updated;
    },
    ctx.txRetry,
  );
}
