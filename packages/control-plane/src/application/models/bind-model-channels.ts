/**
 * 绑定全量替换：事务内删旧插新（空数组 = 解绑全部）；返回新绑定数。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
import { assertBillingConfig, type BillingConfig } from '../../domain/model/model';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface BindModelChannelsDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly audit: AuditSink;
}

export interface BindModelChannelsInput {
  readonly ctx: ControlContext;
  readonly mappingId: number;
  readonly channels: Array<{
    channelId: number;
    upstreamModel?: string;
    /** 渠道成本覆盖（双轨定价）：缺省继承映射官方价；空串归一 NULL */
    costInputPrice?: string | null;
    costOutputPrice?: string | null;
    costCacheInputPrice?: string | null;
    costCacheWritePrice?: string | null;
    costUnitPrice?: string | null;
    costConfig?: Record<string, unknown>;
    /** 成本免费显式标记：true = 成本恒 0（价格列保持继承默认不清写） */
  }>;
}

/** 成本覆盖列归一：空串/undefined → null（继承）；numeric 字符串原样透传 */
function costColumnOf(v: string | null | undefined): string | null {
  const trimmed = typeof v === 'string' ? v.trim() : v;
  return trimmed == null || trimmed === '' ? null : trimmed;
}

/**
 * 成本配置深校验：与映射 billingConfig 同构同校验（形状/窗口重叠/价格域——
 * 单一真相 assertBillingConfig）。空对象/缺省 = 无策略直通。
 */
function assertCostConfig(config: Record<string, unknown> | undefined): void {
  if (config == null || Object.keys(config).length === 0) return;
  assertBillingConfig(config as BillingConfig);
}

export async function bindModelChannels(
  deps: BindModelChannelsDeps,
  input: BindModelChannelsInput,
): Promise<{ bound: number }> {
  const existing = await deps.stores.model.findById(deps.db, input.mappingId);
  if (!existing) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  // 成本配置深校验先于事务（写前拒绝；与创建/更新路径同款域校验）
  for (const ch of input.channels) assertCostConfig(ch.costConfig);
  const bound = await deps.db.transaction((tx) =>
    deps.stores.model.replaceModelChannels(tx, {
      mappingId: input.mappingId,
      // 出站名缺省物化为映射规范名——落库恒显式（热路径无 null 回落分支）
      channels: input.channels.map((ch) => ({
        channelId: ch.channelId,
        upstreamModel: ch.upstreamModel ?? existing.realModel,
        costInputPrice: costColumnOf(ch.costInputPrice),
        costOutputPrice: costColumnOf(ch.costOutputPrice),
        costCacheInputPrice: costColumnOf(ch.costCacheInputPrice),
        costCacheWritePrice: costColumnOf(ch.costCacheWritePrice),
        costUnitPrice: costColumnOf(ch.costUnitPrice),
        costConfig: ch.costConfig ?? {},
      })),
    }),
  );
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'model.bind_channels',
    targetType: 'model_mapping',
    targetId: input.mappingId,
    detail: {
      channelIds: input.channels.map((ch) => ch.channelId),
      upstreamModels: input.channels.map((ch) => ch.upstreamModel ?? existing.realModel),
    },
  });
  return { bound };
}
