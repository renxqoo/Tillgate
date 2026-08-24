/**
 * 轮换 Key(v1 keys.service rotate):同事务「新行(继承全部设置,expiresAt 原样)
 * + 旧行 CAS 吊销」;绑定订阅失格时新行降级个人余额(subscriptionId=null)。
 * 旧吊销竞态失败 → 整事务回滚(两行不共存半态)。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { generateKeyMaterial } from '../domain/credentials.js';
import type { ApiKeyRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export interface RotateKeyResult {
  readonly key: ApiKeyRecord;
  readonly plaintext: string;
}

export async function rotateKey(
  ctx: UseCaseContext,
  input: { userId: number; keyId: number },
): Promise<RotateKeyResult> {
  const owned = await ctx.store.findOwnedKey(ctx.db, { userId: input.userId, keyId: input.keyId });
  if (owned === null) throw AccountsErrors.business('key_not_found', { keyId: input.keyId });
  if (owned.status !== 0) {
    throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });
  }

  // 订阅重新校验:失格(过期/被移除)降级个人余额(v1 降级语义)
  let { subscriptionId } = owned;
  if (subscriptionId !== null) {
    const usable = await ctx.store.findUsableSubscription(ctx.db, {
      userId: input.userId,
      subscriptionId,
    });
    if (usable === null) subscriptionId = null;
  }

  const material = generateKeyMaterial(ctx.policy.keyPrefix);
  const key = await runTx(
    ctx.db,
    async (tx) => {
      const created = await ctx.store.insertKey(tx, {
        keyHash: material.keyHash,
        keyPreview: material.keyPreview,
        userId: owned.userId,
        subscriptionId,
        name: owned.name,
        remark: owned.remark,
        expiresAt: owned.expiresAt,
        rpmLimit: owned.rpmLimit,
        tpmLimit: owned.tpmLimit,
        dailySpendLimit: owned.dailySpendLimit,
        allowPaygFallback: owned.allowPaygFallback,
      });
      const revoked = await ctx.store.revokeKey(tx, { userId: input.userId, keyId: input.keyId });
      if (revoked === null) {
        throw AccountsErrors.business('key_already_revoked', { keyId: input.keyId });
      }
      return created;
    },
    ctx.txRetry,
  );
  return { key, plaintext: material.plaintext };
}
