/**
 * 下架模型映射：软下架（status=1）。0 行 = 不存在。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface RetireModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export interface RetireModelInput {
  readonly ctx: ControlContext;
  readonly mappingId: number;
}

export async function retireModel(
  deps: RetireModelDeps,
  input: RetireModelInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.model.retireMapping(deps.db, { mappingId: input.mappingId });
  if (!ok) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'model.retire',
    targetType: 'model_mapping',
    targetId: input.mappingId,
  });
  return { ok: true as const };
}
