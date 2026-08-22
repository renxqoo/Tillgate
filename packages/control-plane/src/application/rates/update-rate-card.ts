/**
 * 更新费率卡：卡面 patch 与全局系数分离——coefficient 是 scope='global' 系数行的列，
 * 只碰 global 行（M1 回归点：model/group 覆写行隔离），不能混进卡面 patch。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { RateCardStore } from '../../ports/rate-card-store';
import { validateCoefficient, formatCoefficient } from '../../domain/rate-card/coefficient';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateRateCardDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
  readonly audit: AuditSink;
}

export interface UpdateRateCardInput {
  readonly ctx: ControlContext;
  readonly rateCardId: number;
  readonly patch: {
    name?: string;
    description?: string | null;
    status?: number;
    coefficient?: string;
  };
}

export interface UpdatedRateCard {
  readonly id: number;
  readonly name: string;
  readonly coefficient?: string;
}

export async function updateRateCard(
  deps: UpdateRateCardDeps,
  input: UpdateRateCardInput,
): Promise<UpdatedRateCard> {
  const { coefficient, ...cardPatch } = input.patch;
  const row = await deps.db.transaction((tx) =>
    deps.stores.rateCard.updateWithGlobal(tx, {
      rateCardId: input.rateCardId,
      patch: cardPatch,
      globalCoefficient: coefficient !== undefined ? validateCoefficient(coefficient) : undefined,
    }),
  );
  if (!row) {
    throw controlPlaneErrors.business('rate_card_not_found', { rateCardId: input.rateCardId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'rate_card.update',
    targetType: 'rate_card',
    targetId: row.id,
    detail: { patch: input.patch },
  });
  return {
    id: row.id,
    name: row.name,
    ...(coefficient !== undefined ? { coefficient: formatCoefficient(coefficient) } : {}),
  };
}
