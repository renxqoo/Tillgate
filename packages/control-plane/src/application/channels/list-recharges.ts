/**
 * 渠道资金流水列表：q 命中 单号/备注/渠道名；可按渠道与类型过滤。
 */
import type { Db } from '@tokenlens/db';
import type { ChannelStore, RechargeRow, RechargeSortField } from '../../ports/channel-store';
import type { ListQuery, ListResult } from '../../domain/list';

export interface ListRechargesDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
}

export interface ListRechargesInput extends ListQuery<RechargeSortField> {
  readonly channelId?: number;
  readonly type?: 'recharge' | 'adjust';
}

export function listRecharges(
  deps: ListRechargesDeps,
  input: ListRechargesInput,
): Promise<ListResult<RechargeRow>> {
  const { channelId, type, ...query } = input;
  return deps.stores.channel.listRecharges(deps.db, { ...query, channelId, type });
}
