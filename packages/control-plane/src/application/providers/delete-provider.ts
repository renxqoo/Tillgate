/**
 * 删除供应商（逻辑删除/回收站）：status→1 + deleted_at=now。行数据与渠道 FK
 * 引用保留（历史可追溯）；名称随部分唯一索引释放，可重建同名供应商。
 * 下游守卫：名下仍有**在册**渠道时拒绝（provider_has_channels）——须先删除或迁移
 * 渠道；回收站渠道不阻塞。
 * 已删除供应商的渠道在服务面同步停止路由（findRouteCandidates 过滤 deleted_at）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ProviderStore } from '../../ports/provider-store';
import type { ChannelStore } from '../../ports/channel-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface DeleteProviderDeps {
  readonly db: Db;
  readonly stores: {
    readonly provider: ProviderStore;
    readonly channel: ChannelStore;
  };
  readonly audit: AuditSink;
}

export interface DeleteProviderInput {
  readonly ctx: ControlContext;
  readonly providerId: number;
}

export async function deleteProvider(
  deps: DeleteProviderDeps,
  input: DeleteProviderInput,
): Promise<{ ok: true }> {
  const channels = await deps.stores.channel.countActiveByProvider(deps.db, input.providerId);
  if (channels > 0) {
    throw controlPlaneErrors.business('provider_has_channels', {
      providerId: input.providerId,
      activeChannels: channels,
    });
  }
  const ok = await deps.stores.provider.softDelete(deps.db, { providerId: input.providerId });
  if (!ok) {
    throw controlPlaneErrors.business('provider_not_found', { providerId: input.providerId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'provider.delete',
    targetType: 'provider',
    targetId: input.providerId,
  });
  return { ok: true as const };
}
