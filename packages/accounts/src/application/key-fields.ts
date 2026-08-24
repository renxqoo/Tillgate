/**
 * Key 字段域解析(create/patch/rotate/admin-patch 共用,D 类收敛;
 * v1 路由 zod 的领域化形态——拒绝即抛 key_patch_invalid,事实进 context)。
 */
import { AccountsErrors } from '../domain/errors.js';
import { clampOptionalText, normalizeName } from '../domain/fields.js';
import { parseAmountLimit, parseRateLimit } from '../domain/limits.js';
import type { ApiKeyPatch } from '../ports/account-store.js';
import type { AccountsPolicy } from './context.js';

export interface KeyFieldsInput {
  readonly name?: string;
  readonly remark?: string | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly dailySpendLimit?: string | null;
  readonly expiresAt?: Date | null;
}

/** 可变构建形态(-readonly 映射);交付时即 ApiKeyPatch */
type MutableKeyPatch = { -readonly [K in keyof ApiKeyPatch]?: ApiKeyPatch[K] };

/**
 * 可空字段通用解析:undefined → undefined(不落入 patch)、null → null(显式清空)、
 * 非空经 parse 域校验,非法即抛 key_patch_invalid。
 */
function parseNullableField<V, T>(
  value: V | null | undefined,
  field: string,
  parse: (value: V) => T | null,
): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = parse(value);
  if (parsed === null) throw AccountsErrors.business('key_patch_invalid', { field });
  return parsed;
}

export function parseKeyFields(
  input: KeyFieldsInput,
  policy: AccountsPolicy,
  now: Date,
): ApiKeyPatch {
  const patch: MutableKeyPatch = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (name === null) throw AccountsErrors.business('key_patch_invalid', { field: 'name' });
    patch.name = name;
  }
  const remark = parseNullableField(input.remark, 'remark', (v) => clampOptionalText(v, 255));
  if (remark !== undefined) patch.remark = remark;
  const rpmLimit = parseNullableField(input.rpmLimit, 'rpmLimit', (v) =>
    parseRateLimit(v, policy.rpmLimitMax),
  );
  if (rpmLimit !== undefined) patch.rpmLimit = rpmLimit;
  const tpmLimit = parseNullableField(input.tpmLimit, 'tpmLimit', (v) =>
    parseRateLimit(v, policy.tpmLimitMax),
  );
  if (tpmLimit !== undefined) patch.tpmLimit = tpmLimit;
  const dailySpendLimit = parseNullableField(input.dailySpendLimit, 'dailySpendLimit', (v) =>
    parseAmountLimit(v, policy.amountLimitUpper),
  );
  if (dailySpendLimit !== undefined) patch.dailySpendLimit = dailySpendLimit;
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) patch.expiresAt = null;
    else if (input.expiresAt.getTime() <= now.getTime()) {
      throw AccountsErrors.business('key_patch_invalid', { field: 'expiresAt', reason: 'past' });
    } else patch.expiresAt = input.expiresAt;
  }
  return patch;
}
