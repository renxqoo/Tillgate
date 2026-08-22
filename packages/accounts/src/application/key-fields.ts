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

export function parseKeyFields(
  input: KeyFieldsInput,
  policy: AccountsPolicy,
  now: Date,
): ApiKeyPatch {
  const patch: {
    name?: string;
    remark?: string | null;
    rpmLimit?: number | null;
    tpmLimit?: number | null;
    dailySpendLimit?: string | null;
    expiresAt?: Date | null;
  } = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (name === null) throw AccountsErrors.business('key_patch_invalid', { field: 'name' });
    patch.name = name;
  }
  if (input.remark !== undefined) {
    if (input.remark === null) patch.remark = null;
    else {
      const remark = clampOptionalText(input.remark, 255);
      if (remark === null) throw AccountsErrors.business('key_patch_invalid', { field: 'remark' });
      patch.remark = remark;
    }
  }
  if (input.rpmLimit !== undefined) {
    if (input.rpmLimit === null) patch.rpmLimit = null;
    else {
      const rpm = parseRateLimit(input.rpmLimit, policy.rpmLimitMax);
      if (rpm === null) throw AccountsErrors.business('key_patch_invalid', { field: 'rpmLimit' });
      patch.rpmLimit = rpm;
    }
  }
  if (input.tpmLimit !== undefined) {
    if (input.tpmLimit === null) patch.tpmLimit = null;
    else {
      const tpm = parseRateLimit(input.tpmLimit, policy.tpmLimitMax);
      if (tpm === null) throw AccountsErrors.business('key_patch_invalid', { field: 'tpmLimit' });
      patch.tpmLimit = tpm;
    }
  }
  if (input.dailySpendLimit !== undefined) {
    if (input.dailySpendLimit === null) patch.dailySpendLimit = null;
    else {
      const amount = parseAmountLimit(input.dailySpendLimit, policy.amountLimitUpper);
      if (amount === null)
        throw AccountsErrors.business('key_patch_invalid', { field: 'dailySpendLimit' });
      patch.dailySpendLimit = amount;
    }
  }
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) patch.expiresAt = null;
    else if (input.expiresAt.getTime() <= now.getTime())
      throw AccountsErrors.business('key_patch_invalid', { field: 'expiresAt', reason: 'past' });
    else patch.expiresAt = input.expiresAt;
  }
  return patch;
}
