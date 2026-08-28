/**
 * 删除渠道（逻辑删除/回收站）：status→1 + deleted_at=now。历史绑定/资金流水/FK
 * 引用保留可追溯；渠道名随部分唯一索引释放可复用。
 * 下游守卫：仍有**在册**模型映射绑定该渠道时拒绝（channel_has_models）——须先解绑
 * 或删除映射；回收站映射的残留绑定是历史追溯，不阻塞。
 * 在途任务不受影响：worker 轮询（findTaskChannel）不按启用状态过滤，已提交任务保持可达。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import type { ModelStore } from '../../ports/model-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface DeleteChannelDeps {
  readonly db: Db;
  readonly stores: {
    readonly channel: ChannelStore;
    readonly model: ModelStore;
  };
  readonly audit: AuditSink;
}

export interface DeleteChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
}

export async function deleteChannel(
  deps: DeleteChannelDeps,
  input: DeleteChannelInput,
): Promise<{ ok: true }> {
  const bound = await deps.stores.model.countActiveMappingsByChannel(deps.db, input.channelId);
  if (bound > 0) {
    throw controlPlaneErrors.business('channel_has_models', {
      channelId: input.channelId,
      boundModels: bound,
    });
  }
  const ok = await deps.stores.channel.softDeleteChannel(deps.db, { channelId: input.channelId });
  if (!ok) {
    throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'channel.delete',
    targetType: 'channel',
    targetId: input.channelId,
  });
  return { ok: true as const };
}
