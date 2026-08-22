/**
 * 渠道列表（富化）：基础行（join 供应商名，不含密文）+ 绑定模型 + 上游累计消耗。
 * 富化只对当前页 id 集合做两次下推聚合（不在 JS 侧循环打表）。
 */
import type { Db } from '@tokenlens/db';
import type { ChannelStore, ChannelListRow, ChannelSortField } from '../../ports/channel-store';
import type { ListQuery } from '../../domain/list';

export interface ListChannelsDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
}

export interface ChannelListItem extends ChannelListRow {
  readonly boundModels: string[];
  readonly upstreamConsumed: string;
}

export interface ListChannelsResult {
  readonly rows: ChannelListItem[];
  readonly total: number;
}

export async function listChannels(
  deps: ListChannelsDeps,
  query: ListQuery<ChannelSortField>,
): Promise<ListChannelsResult> {
  const result = await deps.stores.channel.listChannels(deps.db, query);
  const pageIds = result.rows.map((row) => row.id);
  const [bindings, consumed] = await Promise.all([
    deps.stores.channel.listBoundModelsByChannelIds(deps.db, pageIds),
    deps.stores.channel.sumUpstreamConsumedByChannelIds(deps.db, pageIds),
  ]);
  const modelsByChannel = new Map<number, string[]>();
  for (const binding of bindings) {
    const list = modelsByChannel.get(binding.channelId) ?? [];
    list.push(binding.externalName);
    modelsByChannel.set(binding.channelId, list);
  }
  return {
    rows: result.rows.map((row) => ({
      ...row,
      boundModels: modelsByChannel.get(row.id) ?? [],
      upstreamConsumed: consumed.get(row.id) ?? '0',
    })),
    total: result.total,
  };
}
