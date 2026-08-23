/**
 * 内存版支付与兑换 stand-in（§5.6 类别 2）：PaymentOrderStore / RedeemCodeStore /
 * RateCounterPort 的行为等价实现，供 application/{payments,redemption} 在无 PG
 * 环境下的契约测试（默认门禁）；真实 PG 语义（唯一约束竞态/并发同码）随 apps 波验证。
 */
import type {
  PaymentOrderStore,
  RateCounterPort,
  RedeemCodeStore,
} from '../ports/payment-ports.js';

export interface InMemoryPaymentOrderRow {
  id: string;
  provider: string;
  providerOrderId: string;
  userId: number;
  amount: string;
  currency: string;
  creditAmount: string;
  status: number;
  createdAt: Date;
}

export function createInMemoryPaymentStores() {
  const orders = new Map<string, InMemoryPaymentOrderRow>();
  const codes = new Map<
    string,
    { id: number; batchId: number; status: number; expiresAt: Date | null; usedBy: number | null }
  >();
  const batches = new Map<number, { name: string; amount: string }>();
  let codeSeq = 0;
  let batchSeq = 0;
  const conn = { connBrand: 'wallet-conn' } as const;

  const orderStore: PaymentOrderStore = {
    insertOrder: (_conn, input) => {
      orders.set(input.id, { ...input, status: 0, createdAt: new Date() });
      return Promise.resolve();
    },
    attachProviderOrderId: (_conn, input) => {
      const row = orders.get(input.orderId);
      if (row && row.status === 0) row.providerOrderId = input.providerOrderId;
      return Promise.resolve();
    },
    findByProviderOrderId: (_conn, input) => {
      for (const row of orders.values()) {
        if (row.provider === input.provider && row.providerOrderId === input.providerOrderId) {
          return Promise.resolve({ ...row });
        }
      }
      return Promise.resolve(null);
    },
    findById: (_conn, orderId) =>
      Promise.resolve(orders.has(orderId) ? { ...orders.get(orderId)! } : null),
    findByUserAndId: (_conn, input) => {
      const row = orders.get(input.orderId);
      return Promise.resolve(row && row.userId === input.userId ? { ...row } : null);
    },
    listByUser: (_conn, input) =>
      Promise.resolve(
        [...orders.values()]
          .filter((row) => row.userId === input.userId)
          .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(input.offset, input.offset + input.limit)
          .map((row) => ({ ...row })),
      ),
    markPaid: (_conn, input) => {
      const row = orders.get(input.orderId);
      if (!row || row.status !== 0) return Promise.resolve(null);
      row.status = 1;
      return Promise.resolve({ id: row.id, creditAmount: row.creditAmount, userId: row.userId });
    },
    markCredited: (_conn, input) => {
      const row = orders.get(input.orderId);
      if (!row || row.status !== 1) return Promise.resolve(false);
      row.status = 2;
      return Promise.resolve(true);
    },
    expireOverdue: (_conn, input) => {
      for (const row of orders.values()) {
        if (
          row.userId === input.userId &&
          row.status === 0 &&
          row.createdAt < input.createdBefore
        ) {
          row.status = 4;
        }
      }
      return Promise.resolve();
    },
    reviveExpiredAsPaid: (_conn, input) => {
      const row = orders.get(input.orderId);
      if (!row || row.status !== 4) return Promise.resolve(false);
      row.status = 1;
      return Promise.resolve(true);
    },
    markChannelFailed: (_conn, orderId) => {
      const row = orders.get(orderId);
      if (row && row.status === 0) row.status = 4;
      return Promise.resolve();
    },
  };

  const codeStore: RedeemCodeStore = {
    findByCodeHash: (_conn, codeHash) => {
      const row = codes.get(codeHash);
      return Promise.resolve(row ? { ...row } : null);
    },
    claim: (_conn, input) => {
      const row = codes.get(input.codeHash);
      if (!row || row.status !== 0 || (row.expiresAt && row.expiresAt <= input.now)) {
        return Promise.resolve(null);
      }
      row.status = 1;
      row.usedBy = input.userId;
      return Promise.resolve({
        codeId: row.id,
        batchId: row.batchId,
        amount: batches.get(row.batchId)?.amount ?? '0',
      });
    },
    insertBatchWithCodes: (_conn, input) => {
      const batchId = (batchSeq += 1);
      batches.set(batchId, { name: input.batchName, amount: input.amount });
      const codeIds: number[] = [];
      for (const codeHash of input.codeHashes) {
        const id = (codeSeq += 1);
        codes.set(codeHash, { id, batchId, status: 0, expiresAt: input.expiresAt, usedBy: null });
        codeIds.push(id);
      }
      return Promise.resolve({ batchId, codeIds });
    },
    listRedeemedByUser: (_conn, input) =>
      Promise.resolve(
        [...codes.entries()]
          .filter(([, row]) => row.usedBy === input.userId && row.status === 1)
          .slice(input.offset, input.offset + input.limit)
          .map(([, row]) => ({
            codeId: row.id,
            batchName: batches.get(row.batchId)?.name ?? '',
            amount: batches.get(row.batchId)?.amount ?? '0',
            usedAt: null,
          })),
      ),
  };

  return { orderStore, codeStore, orders, codes, batches, conn };
}

/** 内存固定窗计数器（窗口按 key 记数，测试用） */
export function createInMemoryRateCounter(failAfter?: number) {
  const counters = new Map<string, number>();
  let calls = 0;
  return {
    counter: {
      hit(key: string, _windowSeconds: number): Promise<number> {
        calls += 1;
        if (failAfter !== undefined && calls > failAfter) {
          return Promise.reject(new Error('counter unavailable'));
        }
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return Promise.resolve(n);
      },
    } as RateCounterPort,
    counters,
    reset: () => counters.clear(),
  };
}
