/**
 * 测试事件入箱:渠道首订阅事件 + {test:true, channel:name} 载荷;dedupeKey `test:{id}:{now-ms}`
 * (同毫秒连点被幂等吞并——by design 单发不重,B2 留档)。实际投递由 dispatch 轮询。
 */
import type { Db } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import { notificationsErrors } from '../errors';
import type { NotifyContext } from './context';

export interface TestChannelDeps {
  readonly db: Db;
  readonly store: NotifyStore;
}

export interface TestChannelInput {
  readonly ctx: NotifyContext;
  readonly channelId: number;
}

export async function testChannel(
  deps: TestChannelDeps,
  input: TestChannelInput,
): Promise<{ ok: true }> {
  const channel = await deps.store.findChannel(deps.db, input.channelId);
  if (!channel)
    throw notificationsErrors.business('channel_not_found', { channelId: input.channelId });
  await deps.db.transaction((tx) =>
    deps.store.insertOutboxEvent(tx, {
      event: channel.events[0] ?? 'channel_disabled',
      payload: { test: true, channel: channel.name },
      dedupeKey: `test:${input.channelId}:${Date.now()}`,
    }),
  );
  return { ok: true };
}
