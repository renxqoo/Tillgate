/**
 * 更新费率卡：卡面 patch 与全局系数分离——coefficient 是 scope='global' 系数行的列，
 * 只碰 global 行（M1 回归点：model/group 覆写行隔离），不能混进卡面 patch。
 * 审计与变更同事务（§5.4/G3）：事务内先读旧行，before/after 都进审计——
 * 费率变更可审计版本（总纲 §3.4：费率变更必须产生可审计版本）。
 */
import type { Db } from '@tillgate/db';
import type { AuditTxSink } from '../../ports/audit-sink';
import type { RateCardStore } from '../../ports/rate-card-store';
import { validateCoefficient, formatCoefficient } from '../../domain/rate-card/coefficient';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAuditWithinTx } from '../audit';

export interface UpdateRateCardDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
  /** 费率审计（事务参与 port，§5.4/G3——写失败随业务事务回滚） */
  readonly auditTx: AuditTxSink;
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
  const row = await deps.db.transaction(async (tx) => {
    // 事务内先读旧行（变更前值进审计；更新后的行在 patch 已知——after 即 input.patch）
    const before = await deps.stores.rateCard.findById(tx, input.rateCardId);
    const beforeCoefficient =
      coefficient !== undefined
        ? await deps.stores.rateCard.findGlobalCoefficient(tx, input.rateCardId)
        : undefined;
    const updated = await deps.stores.rateCard.updateWithGlobal(tx, {
      rateCardId: input.rateCardId,
      patch: cardPatch,
      globalCoefficient: coefficient !== undefined ? validateCoefficient(coefficient) : undefined,
    });
    if (!updated) return null;
    // 审计与变更同事务提交前落（§5.4/G3）：before/after 都进 detail
    await emitAuditWithinTx(deps.auditTx, tx, {
      actor: 'admin',
      adminId: adminIdOf(input.ctx),
      action: 'rate_card.update',
      targetType: 'rate_card',
      targetId: updated.id,
      detail: {
        before:
          before == null
            ? null
            : {
                name: before.name,
                description: before.description,
                status: before.status,
                ...(beforeCoefficient !== undefined ? { coefficient: beforeCoefficient } : {}),
              },
        after: input.patch,
      },
    });
    return updated;
  });
  if (!row) {
    throw controlPlaneErrors.business('rate_card_not_found', { rateCardId: input.rateCardId });
  }
  return {
    id: row.id,
    name: row.name,
    ...(coefficient !== undefined ? { coefficient: formatCoefficient(coefficient) } : {}),
  };
}
