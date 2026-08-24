/**
 * 建费率卡：系数域校验（0.001–9.999 三位小数）→ 建卡 + 全局兜底系数同事务两写 → 审计。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { RateCardStore } from '../../ports/rate-card-store';
import { validateCoefficient } from '../../domain/rate-card/coefficient';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface CreateRateCardDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
  readonly audit: AuditSink;
}

export interface CreateRateCardInput {
  readonly ctx: ControlContext;
  readonly name: string;
  readonly description?: string;
  readonly coefficient: string;
}

export interface CreatedRateCard {
  readonly id: number;
  readonly name: string;
  readonly coefficient: string;
}

export async function createRateCard(
  deps: CreateRateCardDeps,
  input: CreateRateCardInput,
): Promise<CreatedRateCard> {
  const coefficient = validateCoefficient(input.coefficient);
  const card = await deps.db.transaction((tx) =>
    deps.stores.rateCard.insertWithGlobal(tx, {
      name: input.name,
      description: input.description ?? null,
      coefficient,
    }),
  );
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'rate_card.create',
    targetType: 'rate_card',
    targetId: card.id,
    detail: { name: card.name, coefficient },
  });
  return { id: card.id, name: card.name, coefficient };
}
