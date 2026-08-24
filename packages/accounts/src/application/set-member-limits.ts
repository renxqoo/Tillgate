/**
 * owner 设置成员限额(日限 a / 子配额 b;v1 patchMember)。
 * B5 修复:仅 active 成员可设限(离开成员 → member_not_found,不再静默成功)。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { parseAmountLimit } from '../domain/limits.js';
import type { MembershipRecord } from '../ports/account-store.js';
import { requireOwnerMembership } from './org-guards.js';
import type { UseCaseContext } from './context.js';

export async function setMemberLimits(
  ctx: UseCaseContext,
  input: {
    orgId: number;
    operatorUserId: number;
    memberUserId: number;
    dailySpendLimit?: string | null;
    monthlyQuota?: string | null;
  },
): Promise<MembershipRecord> {
  await requireOwnerMembership(ctx, { orgId: input.orgId, userId: input.operatorUserId });

  const patch: { dailySpendLimit?: string | null; monthlyQuota?: string | null } = {};
  if (input.dailySpendLimit !== undefined) {
    if (input.dailySpendLimit === null) patch.dailySpendLimit = null;
    else {
      const amount = parseAmountLimit(input.dailySpendLimit, ctx.policy.amountLimitUpper);
      if (amount === null) {
        throw AccountsErrors.business('member_limits_invalid', { field: 'dailySpendLimit' });
      }
      patch.dailySpendLimit = amount;
    }
  }
  if (input.monthlyQuota !== undefined) {
    if (input.monthlyQuota === null) patch.monthlyQuota = null;
    else {
      const amount = parseAmountLimit(input.monthlyQuota, ctx.policy.amountLimitUpper);
      if (amount === null) {
        throw AccountsErrors.business('member_limits_invalid', { field: 'monthlyQuota' });
      }
      patch.monthlyQuota = amount;
    }
  }

  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.patchMember(tx, {
        orgId: input.orgId,
        userId: input.memberUserId,
        patch,
      });
      if (updated === null) {
        throw AccountsErrors.business('member_not_found', { userId: input.memberUserId });
      }
      return updated;
    },
    ctx.txRetry,
  );
}
