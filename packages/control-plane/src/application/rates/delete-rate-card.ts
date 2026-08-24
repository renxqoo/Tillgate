/**
 * 删除费率卡（硬删，系数行先于卡行）：删除前置 = 无用户绑定（409 rate_card_in_use）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { RateCardStore } from '../../ports/rate-card-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface DeleteRateCardDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
  readonly audit: AuditSink;
}

export interface DeleteRateCardInput {
  readonly ctx: ControlContext;
  readonly rateCardId: number;
}

export async function deleteRateCard(
  deps: DeleteRateCardDeps,
  input: DeleteRateCardInput,
): Promise<{ ok: true }> {
  const bound = await deps.stores.rateCard.countBoundUsers(deps.db, input.rateCardId);
  if (bound > 0) {
    throw controlPlaneErrors.business('rate_card_in_use', {
      rateCardId: input.rateCardId,
      boundUsers: bound,
    });
  }
  const ok = await deps.db.transaction((tx) =>
    deps.stores.rateCard.deleteCard(tx, { rateCardId: input.rateCardId }),
  );
  if (!ok) {
    throw controlPlaneErrors.business('rate_card_not_found', { rateCardId: input.rateCardId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'rate_card.delete',
    targetType: 'rate_card',
    targetId: input.rateCardId,
  });
  return { ok: true as const };
}
