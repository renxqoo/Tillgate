/**
 * 返利流水管理读侧（v1 marketing.repo listPayouts 迁移;accounts G3 裁决落位于
 * billing——payouts 是 wallet 流水投影,资金单一真相在本包;admin-api P3 消费）。
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
