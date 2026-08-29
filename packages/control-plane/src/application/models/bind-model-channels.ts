/**
 * 绑定全量替换：事务内删旧插新（空数组 = 解绑全部）；返回新绑定数。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
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
    weight?: number;
    priority?: number;
  }>;
}

export async function bindModelChannels(
  deps: BindModelChannelsDeps,
  input: BindModelChannelsInput,
): Promise<{ bound: number }> {
  const existing = await deps.stores.model.findById(deps.db, input.mappingId);
  if (!existing) {
    throw controlPlaneErrors.business('model_not_found', { mappingId: input.mappingId });
  }
  const bound = await deps.db.transaction((tx) =>
    deps.stores.model.replaceModelChannels(tx, {
      mappingId: input.mappingId,
      // 出站名缺省物化为映射规范名——落库恒显式（热路径无 null 回落分支）
      channels: input.channels.map((ch) => ({
        channelId: ch.channelId,
        upstreamModel: ch.upstreamModel ?? existing.realModel,
        weight: ch.weight ?? 1,
        priority: ch.priority ?? 0,
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
