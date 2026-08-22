/**
 * 创建 API Key(v1 keys.service create):字段域 → 订阅归属守卫 → 生成材料 → 落库。
 * 明文仅本用例返回值出现一次;库内只存 SHA-256 + 脱敏预览。
 */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import { generateKeyMaterial } from '../domain/credentials.js';
import type { ApiKeyRecord } from '../ports/account-store.js';
import { parseKeyFields } from './key-fields.js';
import type { UseCaseContext } from './context.js';

export interface CreateKeyInput {
  readonly userId: number;
  readonly name: string;
  readonly remark?: string | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly dailySpendLimit?: string | null;
  readonly expiresAt?: Date | null;
  readonly subscriptionId?: number | null;
  readonly allowPaygFallback?: boolean;
}

export interface CreateKeyResult {
  readonly key: ApiKeyRecord;
  readonly plaintext: string;
}

export async function createKey(
  ctx: UseCaseContext,
  input: CreateKeyInput,
): Promise<CreateKeyResult> {
  const fields = parseKeyFields(
    {
      name: input.name,
      remark: input.remark,
      rpmLimit: input.rpmLimit,
      tpmLimit: input.tpmLimit,
      dailySpendLimit: input.dailySpendLimit,
      expiresAt: input.expiresAt,
    },
    ctx.policy,
    ctx.now(),
  );

  if (input.subscriptionId !== undefined && input.subscriptionId !== null) {
    const usable = await ctx.store.findUsableSubscription(ctx.db, {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
    });
    if (usable === null) {
      throw AccountsErrors.business('subscription_not_usable', {
        subscriptionId: input.subscriptionId,
      });
    }
  }

  const material = generateKeyMaterial(ctx.policy.keyPrefix);
  const key = await runTx(
    ctx.db,
    (tx) =>
      ctx.store.insertKey(tx, {
        keyHash: material.keyHash,
        keyPreview: material.keyPreview,
        userId: input.userId,
        subscriptionId: input.subscriptionId ?? null,
        name: fields.name!,
        remark: fields.remark ?? null,
        expiresAt: fields.expiresAt ?? null,
        rpmLimit: fields.rpmLimit ?? null,
        tpmLimit: fields.tpmLimit ?? null,
        dailySpendLimit: fields.dailySpendLimit ?? null,
        allowPaygFallback: input.allowPaygFallback ?? false,
      }),
    ctx.txRetry,
  );
  return { key, plaintext: material.plaintext };
}
