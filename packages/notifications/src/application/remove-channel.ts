/**
 * 删除渠道:硬删(v1 语义);0 行 = channel_not_found。已入箱事件的 delivered_channel_ids
 * 引用不级联——投递循环对已删渠道自然跳过(目标筛选以快照渠道为准)。
 */
import type { Db } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import { notificationsErrors } from '../errors';
import type { NotifyContext } from './context';

export interface RemoveChannelDeps {
  readonly db: Db;
  readonly store: NotifyStore;
}

export interface RemoveChannelInput {
  readonly ctx: NotifyContext;
  readonly channelId: number;
}

export async function removeChannel(
  deps: RemoveChannelDeps,
  input: RemoveChannelInput,
): Promise<{ ok: true }> {
  const removed = await deps.db.transaction((tx) => deps.store.removeChannel(tx, input.channelId));
  if (!removed) {
    throw notificationsErrors.business('channel_not_found', { channelId: input.channelId });
  }
  return { ok: true };
}
