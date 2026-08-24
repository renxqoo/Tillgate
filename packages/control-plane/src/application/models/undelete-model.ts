/**
 * 恢复已删除的模型映射（回收站取出）：deleted_at→NULL，status 固定回 1（下架态）——
 * 不直接复活上架，复核后由管理员显式上架（与「下架≠上架」的保守默认一致）。
 * 仅已删除行可恢复；在册行走常规 PATCH（此处 404）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UndeleteModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export interface UndeleteModelInput {
  readonly ctx: ControlContext;
  readonly mappingId: number;
}

export async function undeleteModel(
  deps: UndeleteModelDeps,
  input: UndeleteModelInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.model.restoreMapping(deps.db, { mappingId: input.mappingId });
  if (!ok) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'model.undelete',
    targetType: 'model_mapping',
    targetId: input.mappingId,
  });
  return { ok: true as const };
}
