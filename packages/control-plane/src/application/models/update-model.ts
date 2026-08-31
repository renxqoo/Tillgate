/** 更新模型映射。价格变更影响计费：全量补丁进审计（历史可解释）。 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore, ModelRecord } from '../../ports/model-store';
import type { ModelPatchInput } from '../../domain/model/model';
import { validateModelPatch } from '../../domain/model/model';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export interface UpdateModelInput {
  readonly ctx: ControlContext;
  readonly mappingId: number;
  readonly patch: ModelPatchInput;
}

// eslint-disable-next-line complexity -- 用例编排:字段合并相容判+审计分支,各分支独立无嵌套
export async function updateModel(
  deps: UpdateModelDeps,
  input: UpdateModelInput,
): Promise<ModelRecord> {
  const validated = validateModelPatch(input.patch);
  const existing = await deps.stores.model.findById(deps.db, input.mappingId);
  if (!existing) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }

  const { prices, billingConfig, ...rest } = validated;
  // null=清除变体配置（列 notNull：清成 {}）；undefined=不改
  const patchRest =
    billingConfig === undefined ? rest : { ...rest, billingConfig: billingConfig ?? {} };
  const row = await deps.db.transaction((tx) =>
    deps.stores.model.updateMapping(tx, {
      mappingId: input.mappingId,
      patch: { ...patchRest, ...prices },
    }),
  );
  if (!row) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'model.update',
    targetType: 'model_mapping',
    targetId: row.id,
    detail: { patch: input.patch },
  });
  return row;
}
