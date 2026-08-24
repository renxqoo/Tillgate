/**
 * 删除模型映射（逻辑删除/回收站）：status→1 + deleted_at=now。记录与渠道绑定
 * 保留（历史计费可追溯）；外部名随部分唯一索引释放，可重建/再导入同名映射。
 * 已删除记录对管理面读/改/探针不可见（404 语义由各读路径 isNull 过滤保证）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface DeleteModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export interface DeleteModelInput {
  readonly ctx: ControlContext;
  readonly mappingId: number;
}

export async function deleteModel(
  deps: DeleteModelDeps,
  input: DeleteModelInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.model.softDeleteMapping(deps.db, { mappingId: input.mappingId });
  if (!ok) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'model.delete',
    targetType: 'model_mapping',
    targetId: input.mappingId,
  });
  return { ok: true as const };
}
