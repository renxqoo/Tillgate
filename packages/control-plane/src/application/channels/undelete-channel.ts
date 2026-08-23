/**
 * 恢复已删除的渠道（回收站取出）：deleted_at→NULL，status 固定回 1（停用态）——
 * 不直接启用，复核后由管理员显式启用。仅已删除行可恢复；在册行走常规 PATCH（此处 404）。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UndeleteChannelDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
  readonly audit: AuditSink;
}

export interface UndeleteChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
}

export async function undeleteChannel(
  deps: UndeleteChannelDeps,
  input: UndeleteChannelInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.channel.restoreChannel(deps.db, { channelId: input.channelId });
  if (!ok) {
    throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'channel.undelete',
    targetType: 'channel',
    targetId: input.channelId,
  });
  return { ok: true as const };
}
