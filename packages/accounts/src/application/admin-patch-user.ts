/**
 * 管理面用户补丁(v1 users.service patch 语义重构):
 * - freezeReason 只能随封禁出现(v1 superRefine);封禁缺省原因注入;解封清原因;
 * - email 变更 = 身份事实变更,同事务经 SessionInvalidationPort 推进 identity 吊销线(全网下线;§3.4 唯一所有者);
 * - 换卡守卫两分(不存在/停用);限额域校验;
 * - 审计 user.update 同事务落库(全量 patch detail)。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { normalizeValidEmail, normalizeName, FIELD_LIMITS } from '../domain/fields.js';
import { isNonNegativeAmountWithin, parseRateLimit } from '../domain/limits.js';
import { USER_STATUS, USER_STATUSES } from '../domain/status.js';
import type { UserPatch, UserRecord } from '../ports/account-store.js';
import type { UserStatus } from '../domain/status.js';
import { SESSION_REALM } from '../ports/session-invalidation.js';
import type { UseCaseContext } from './context.js';

export interface AdminUserPatchInput {
  readonly displayName?: string;
  readonly email?: string | null;
  readonly rateCardId?: number | null;
  readonly status?: number;
  readonly freezeReason?: string | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly dailySpendLimit?: string | null;
  readonly isEnterprise?: boolean;
}

export async function adminPatchUser(
  ctx: UseCaseContext,
  input: { userId: number; patch: AdminUserPatchInput; adminId: number },
): Promise<UserRecord> {
  const raw = input.patch;
  /** 可变构建形态(-readonly 映射);交付时即 UserPatch */
  const patch: { -readonly [K in keyof UserPatch]?: UserPatch[K] } = {};

  if (raw.status !== undefined) {
    if (!USER_STATUSES.includes(raw.status as UserStatus)) {
      throw AccountsErrors.business('user_patch_invalid', { field: 'status', value: raw.status });
    }
    patch.status = raw.status;
  }
  if (raw.freezeReason !== undefined) {
    if (raw.freezeReason !== null) {
      const reason = raw.freezeReason.trim();
      if (reason.length < 1 || reason.length > FIELD_LIMITS.freezeReason) {
        throw AccountsErrors.business('user_patch_invalid', { field: 'freezeReason' });
      }
      if (patch.status !== USER_STATUS.BANNED) {
        throw AccountsErrors.business('user_patch_invalid', {
          field: 'freezeReason',
          reason: 'requires_status_banned',
        });
      }
      patch.freezeReason = reason;
    } else {
      patch.freezeReason = null;
    }
  }
  // 封禁缺省原因 / 解封清原因(v1 users.service:162-163)
  if (patch.status === USER_STATUS.BANNED && patch.freezeReason === undefined) {
    patch.freezeReason = ctx.policy.banDefaultReason;
  }
  if (patch.status === USER_STATUS.ACTIVE) patch.freezeReason = null;

  let advanceSessionAnchor = false;
  if (raw.email !== undefined && raw.email !== null) {
    const email = normalizeValidEmail(raw.email);
    if (email === null) throw AccountsErrors.business('email_invalid', { email: raw.email });
    patch.email = email;
    advanceSessionAnchor = true;
  }

  if (raw.displayName !== undefined) {
    const name = normalizeName(raw.displayName);
    if (name === null) throw AccountsErrors.business('display_name_invalid');
    patch.displayName = name;
  }

  if (raw.rateCardId !== undefined && raw.rateCardId !== null) {
    const probe = await ctx.store.rateCardUsable(ctx.db, raw.rateCardId);
    if (probe.status === 'missing') {
      throw AccountsErrors.business('rate_card_not_found', { rateCardId: raw.rateCardId });
    }
    if (probe.status === 'disabled') {
      throw AccountsErrors.business('rate_card_disabled', { rateCardId: raw.rateCardId });
    }
    patch.rateCardId = raw.rateCardId;
  } else if (raw.rateCardId === null) {
    patch.rateCardId = null;
  }

  if (raw.rpmLimit !== undefined) {
    if (raw.rpmLimit === null) patch.rpmLimit = null;
    else {
      const rpm = parseRateLimit(raw.rpmLimit, ctx.policy.rpmLimitMax);
      if (rpm === null) throw AccountsErrors.business('user_patch_invalid', { field: 'rpmLimit' });
      patch.rpmLimit = rpm;
    }
  }
  if (raw.tpmLimit !== undefined) {
    if (raw.tpmLimit === null) patch.tpmLimit = null;
    else {
      const tpm = parseRateLimit(raw.tpmLimit, ctx.policy.tpmLimitMax);
      if (tpm === null) throw AccountsErrors.business('user_patch_invalid', { field: 'tpmLimit' });
      patch.tpmLimit = tpm;
    }
  }
  if (raw.dailySpendLimit !== undefined) {
    if (raw.dailySpendLimit === null) patch.dailySpendLimit = null;
    else {
      // 管理面允许 0(即日全拒;v1 admin zod 非负),但不得超过业务上界
      if (!isNonNegativeAmountWithin(raw.dailySpendLimit, ctx.policy.amountLimitUpper)) {
        throw AccountsErrors.business('user_patch_invalid', { field: 'dailySpendLimit' });
      }
      patch.dailySpendLimit = raw.dailySpendLimit;
    }
  }
  if (raw.isEnterprise !== undefined) patch.isEnterprise = raw.isEnterprise;

  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.updateUser(tx, {
        userId: input.userId,
        patch,
      });
      if (updated === null)
        throw AccountsErrors.business('user_not_found', { userId: input.userId });
      // email 变更:同事务推进 identity 吊销线(§3.4;回滚即未失效,失败随事务回滚)
      if (advanceSessionAnchor) {
        await ctx.sessionInvalidation.invalidateUserSessions(tx, {
          realm: SESSION_REALM,
          userId: input.userId,
        });
      }
      await ctx.audit.record(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'user.update',
        targetType: 'user',
        targetId: String(input.userId),
        detail: { patch },
      });
      return updated;
    },
    ctx.txRetry,
  );
}
