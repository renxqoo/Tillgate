/**
 * 更新模型映射。免费一致性按「旧值 ∪ 新值」合并判——部分补丁不能造出
 * 「isFree=true + 非零价」矛盾态（如只改 outputPrice>0）。
 * 价格变更影响计费：全量补丁进审计（历史可解释）。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore, ModelRecord } from '../../ports/model-store';
import type { ModelPatchInput } from '../../domain/model/model';
import { validateModelPatch } from '../../domain/model/model';
import { freePriceConsistent } from '../../domain/model/model-pricing';
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

export async function updateModel(
  deps: UpdateModelDeps,
  input: UpdateModelInput,
): Promise<ModelRecord> {
  const validated = validateModelPatch(input.patch);
  const existing = await deps.stores.model.findById(deps.db, input.mappingId);
  if (!existing) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }

  // 合并口径判相容：部分补丁不得造出「isFree=true + 非零价」矛盾态
  const mergedPrices = {
    inputPrice: validated.prices?.inputPrice ?? existing.inputPrice,
    outputPrice: validated.prices?.outputPrice ?? existing.outputPrice,
    cacheInputPrice: validated.prices?.cacheInputPrice ?? existing.cacheInputPrice,
    cacheWritePrice: validated.prices?.cacheWritePrice ?? existing.cacheWritePrice,
    unitPrice: validated.prices?.unitPrice ?? existing.unitPrice,
  };
  const mergedFree = validated.isFree ?? existing.isFree;
  if (!freePriceConsistent(mergedFree, mergedPrices)) {
    throw controlPlaneErrors.business('free_price_conflict', {
      mappingId: input.mappingId,
      isFree: mergedFree,
    });
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
