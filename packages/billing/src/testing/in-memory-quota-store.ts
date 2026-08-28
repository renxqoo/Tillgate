/**
 * 内存订阅额度 store（user_subscriptions 守卫三原语 + 快照/成员限额的 stand-in）。
 * 从 in-memory-billing-store 拆出（文件行数上限）。
 */
import type { SubscriptionQuotaStore } from '../ports/funding-ports.js';
import type { WalletConn } from '../ports/wallet-store.js';
import type { InMemorySubscriptionRow } from './in-memory-billing-store.js';

export function createInMemoryQuotaStore(deps: {
  subscriptions: Map<number, InMemorySubscriptionRow>;
  memberLimitsOverride: Map<
    string,
    { dailySpendLimit: string | null; monthlyQuota: string | null }
  >;
}): SubscriptionQuotaStore {
  const { subscriptions, memberLimitsOverride } = deps;
  return {
    activeSubscriptionSnapshot(_conn, subscriptionId, now) {
      const row = subscriptions.get(subscriptionId);
      if (!row || row.status !== 0 || row.endAt <= now) return Promise.resolve(null);
      return Promise.resolve({
        userId: row.userId,
        orgId: row.orgId,
        quotaAmount: row.quotaAmount,
        usedAmount: row.usedAmount,
        reservedAmount: row.reservedAmount,
      });
    },

    memberLimits: (_conn, input) => {
      const override = memberLimitsOverride.get(`${input.orgId}\0${input.userId}`);
      return Promise.resolve(override ?? null);
    },

    tryReserveQuota(_conn: WalletConn, input: { subscriptionId: number; amount: string }) {
      const row = subscriptions.get(input.subscriptionId);
      if (!row || row.status !== 0) return Promise.resolve('inactive');
      if (
        Number(row.quotaAmount) - Number(row.usedAmount) - Number(row.reservedAmount) <
        Number(input.amount)
      ) {
        return Promise.resolve('exhausted');
      }
      row.reservedAmount = String(Number(row.reservedAmount) + Number(input.amount));
      return Promise.resolve('ok');
    },

    tryReleaseQuota(_conn: WalletConn, input: { subscriptionId: number; reserved: string }) {
      const row = subscriptions.get(input.subscriptionId);
      if (!row || Number(row.reservedAmount) < Number(input.reserved)) {
        return Promise.resolve(false);
      }
      row.reservedAmount = String(Number(row.reservedAmount) - Number(input.reserved));
      return Promise.resolve(true);
    },

    trySettleQuota(
      _conn: WalletConn,
      input: { subscriptionId: number; reserved: string; consumed: string },
    ) {
      const row = subscriptions.get(input.subscriptionId);
      if (
        !row ||
        Number(row.reservedAmount) < Number(input.reserved) ||
        Number(row.usedAmount) +
          Number(input.consumed) +
          (Number(row.reservedAmount) - Number(input.reserved)) >
          Number(row.quotaAmount)
      ) {
        return Promise.resolve(false);
      }
      row.reservedAmount = String(Number(row.reservedAmount) - Number(input.reserved));
      row.usedAmount = String(Number(row.usedAmount) + Number(input.consumed));
      return Promise.resolve(true);
    },
  };
}
