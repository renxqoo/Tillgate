/**
 * 创建模型映射：数值域/词表/免费一致性校验 → 重名前置检查（唯一索引兜底）→ 落库 → 审计。
 * 重名错误回执带已存在 id 与状态（管理员可定位，不再盲猜 23505）。
 */
import { isUniqueViolation, type Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore, ModelRecord } from '../../ports/model-store';
import type { ModelCreateInput } from '../../domain/model/model';
import { validateModelCreate } from '../../domain/model/model';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface CreateModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export type CreateModelInput = {
  readonly ctx: ControlContext;
} & ModelCreateInput;

// eslint-disable-next-line max-lines-per-function -- 用例编排:校验→重名前置→插入→绑渠道→审计
export async function createModel(
  deps: CreateModelDeps,
  input: CreateModelInput,
): Promise<ModelRecord> {
  const { ctx, ...rest } = input;
  const validated = validateModelCreate(rest);
  // 重名前置检查：唯一索引兜底仍在，但错误要说人话（原 23505 被折叠成三合一盲猜）
  const existing = await deps.stores.model.findByExternalName(deps.db, validated.externalName);
  if (existing) {
    throw controlPlaneErrors.business('model_exists', {
      externalName: existing.externalName,
      existingId: existing.id,
      existingStatus: existing.status === 0 ? 'enabled' : 'disabled',
    });
  }
  let row: ModelRecord;
  try {
    row = await deps.db.transaction((tx) =>
      deps.stores.model.insertMapping(tx, {
        externalName: validated.externalName,
        realModel: validated.realModel,
        contextLength: validated.contextLength,
        inputPrice: validated.prices.inputPrice,
        outputPrice: validated.prices.outputPrice,
        cacheInputPrice: validated.prices.cacheInputPrice,
        cacheWritePrice: validated.prices.cacheWritePrice,
        unitPrice: validated.prices.unitPrice,
        pricingUnit: validated.pricingUnit,
        billingConfig: validated.billingConfig,
        isFree: validated.isFree,
        billingPolicy: validated.billingPolicy,
        rpmLimit: validated.rpmLimit,
        tpmLimit: validated.tpmLimit,
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw controlPlaneErrors.business('model_exists', {
        externalName: validated.externalName,
      });
    }
    throw error;
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(ctx),
    action: 'model.create',
    targetType: 'model_mapping',
    targetId: row.id,
    detail: {
      externalName: row.externalName,
      realModel: row.realModel,
      prices: validated.prices,
      isFree: validated.isFree,
    },
  });
  return row;
}
