/**
 * 创建 API Key:字段域 → 订阅归属守卫 → 生成材料 → 落库。
 * 明文仅本用例返回值出现一次;库内只存 SHA-256 + 脱敏预览。
 */
import { runTx } from '@tillgate/db';
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
  // CreateKeyInput 结构上即 KeyFieldsInput(键字段一一对应),直接整体送解析
  const fields = parseKeyFields(input, ctx.policy, ctx.now());

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
  // createKey 的 name 为必填入参,parseKeyFields 必然落值;守卫仅防御调用方契约漂移
  const keyName = fields.name;
  if (keyName === undefined) {
    throw AccountsErrors.business('key_patch_invalid', { field: 'name' });
  }
  const key = await runTx(
    ctx.db,
    (tx) =>
      ctx.store.insertKey(tx, {
        keyHash: material.keyHash,
        keyPreview: material.keyPreview,
        userId: input.userId,
        subscriptionId: input.subscriptionId ?? null,
        name: keyName,
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
