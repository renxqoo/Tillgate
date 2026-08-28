/**
 * 返利流水管理读侧（payouts 是 wallet 流水投影,资金单一真相在本包;admin-api 消费）。
 * kind 词表在 ports 单点;分页口径由调用方收口（listPlans 同例）。
 */
import type {
  ReferralPayoutKind,
  ReferralPayoutRow,
  WalletStore,
} from '../../ports/wallet-store.js';

export interface ReferralPayoutsQuery {
  kind: ReferralPayoutKind;
  limit: number;
  offset: number;
}

export interface ReferralPayoutsResult {
  rows: ReferralPayoutRow[];
  total: number;
}

export function createReferralPayoutsUseCase(env: {
  store: Pick<WalletStore, 'read' | 'listReferralPayouts'>;
}) {
  return {
    list: (query: ReferralPayoutsQuery): Promise<ReferralPayoutsResult> =>
      env.store.read((conn) => env.store.listReferralPayouts(conn, query)),
  };
}
