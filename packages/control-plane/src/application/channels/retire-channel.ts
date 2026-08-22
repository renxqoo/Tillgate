/**
 * 退役渠道：软删（status=1，历史绑定/流水保留）。0 行 = 不存在。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface RetireChannelDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
  readonly audit: AuditSink;
}

export interface RetireChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
}

export async function retireChannel(
  deps: RetireChannelDeps,
  input: RetireChannelInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.channel.retireChannel(deps.db, { channelId: input.channelId });
  if (!ok) {
    throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'channel.retire',
    targetType: 'channel',
    targetId: input.channelId,
  });
  return { ok: true as const };
}
