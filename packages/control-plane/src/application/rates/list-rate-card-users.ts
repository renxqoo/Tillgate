/**
 * 卡内用户列表（q 命中 subject/email/displayName；跨域只读 users）。
 */
import type { Db } from '@tillgate/db';
import type {
  RateCardStore,
  RateCardUserRow,
  RateCardUserSortField,
} from '../../ports/rate-card-store';
import type { ListQuery, ListResult } from '../../domain/list';

export interface ListRateCardUsersDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
}

export type ListRateCardUsersInput = {
  readonly rateCardId: number;
} & ListQuery<RateCardUserSortField>;

export function listRateCardUsers(
  deps: ListRateCardUsersDeps,
  input: ListRateCardUsersInput,
): Promise<ListResult<RateCardUserRow>> {
  const { rateCardId, ...query } = input;
  return deps.stores.rateCard.listCardUsers(deps.db, { ...query, rateCardId });
}
