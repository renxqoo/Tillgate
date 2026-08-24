/**
 * 推荐关系封禁/恢复(管理面;v1 setRelationStatus):封禁=停发不停历史
 * (worker 派奖前复查;已入账不冲正);同事务审计。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { REFERRAL_STATUSES } from '../domain/status.js';
import type { RelationView } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function setReferralRelationStatus(
  ctx: UseCaseContext,
  input: { relationId: number; status: number; adminId: number },
): Promise<RelationView> {
  if (!REFERRAL_STATUSES.includes(input.status)) {
    throw AccountsErrors.business('relation_status_invalid', { status: input.status });
  }
  return runTx(
    ctx.db,
    async (tx) => {
      const updated = await ctx.store.setReferralRelationStatus(tx, {
        relationId: input.relationId,
        status: input.status,
      });
      if (updated === null)
        throw AccountsErrors.business('relation_not_found', { relationId: input.relationId });
      await ctx.audit.record(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'referral.relation.update',
        targetType: 'referral_relation',
        targetId: String(input.relationId),
        detail: { status: input.status },
      });
      return updated;
    },
    ctx.txRetry,
  );
}
