/**
 * 渠道列表:全量行,secret 恒掩码(密文不回显——任何管理会话/库转储都不该拿到
 * 可伪造通知的 secret,v1 语义)。
 */
import type { DbLike } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import { maskChannelConfig } from '../domain/channel';
import type { NotificationChannel } from '../domain/channel';

export interface ListChannelsDeps {
  readonly db: DbLike;
  readonly store: NotifyStore;
}

/** 管理面返回行:config.secret 已掩码(****+尾4,掩的是密文) */
export interface MaskedChannel {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly config: Record<string, unknown>;
  readonly events: string[];
  readonly status: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 掩码出口(create/patch 返回面复用同一口径) */
export function maskChannelRow(channel: NotificationChannel): MaskedChannel {
  return { ...channel, config: maskChannelConfig(channel.config) };
}

export async function listChannels(deps: ListChannelsDeps): Promise<MaskedChannel[]> {
  const rows = await deps.store.listChannels(deps.db, { activeOnly: false });
  return rows.map(maskChannelRow);
}
