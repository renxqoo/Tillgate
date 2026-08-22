/**
 * 费率卡列表：各卡全局系数回显（缺行按 '1.000' 兜底——「每卡恰一全局行」的应用侧口径）。
 */
import type { Db } from '@tokenlens/db';
import type { RateCardStore, RateCardRecord, RateCardSortField } from '../../ports/rate-card-store';
import type { ListQuery, ListResult } from '../../domain/list';

export interface ListRateCardsDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
}

export interface RateCardListItem extends RateCardRecord {
  readonly coefficient: string;
}

export async function listRateCards(
  deps: ListRateCardsDeps,
  query: ListQuery<RateCardSortField>,
): Promise<ListResult<RateCardListItem>> {
  const result = await deps.stores.rateCard.list(deps.db, query);
  return {
    rows: result.rows.map((row) => ({ ...row, coefficient: row.globalCoefficient ?? '1.000' })),
    total: result.total,
  };
}
