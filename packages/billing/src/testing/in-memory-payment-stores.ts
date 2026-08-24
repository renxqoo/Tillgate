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
  /** 管理列表的用户列投影源(内存形态测试注入;缺省无用户域 = null) */
  displayName?: string | null;
  /** 关单/列表回读的留痕列 */
  failureReason?: string | null;
}

export function createInMemoryPaymentStores() {
  const orders = new Map<string, InMemoryPaymentOrderRow>();
  const codes = new Map<
    string,
    {
      id: number;
      batchId: number;
      status: number;
      expiresAt: Date | null;
      usedBy: number | null;
      usedAt: Date | null;
    }
  >();
  const batches = new Map<
    number,
    {
      name: string;
      remark: string | null;
      amount: string;
      total: number;
      usedCount: number;
      createdBy: number;
      createdAt: Date;
    }
  >();
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
    findById: (_conn, orderId) => {
      const row = orders.get(orderId);
      return Promise.resolve(row ? { ...row } : null);
    },
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
    listAdminOrders: (_conn, input) => {
      // q 双锚:v1 语义——订单 uuid 精确命中或用户显示名精确匹配
      const matched = [...orders.values()].filter((row) => {
        if (input.q === undefined) return true;
        return row.id === input.q || row.displayName === input.q;
      });
      const dir = input.order === 'asc' ? 1 : -1;
      const sorted = matched.toSorted((a, b) => {
        // 排序键类型分野:id 为 uuid 字符串序,amount 数值序,createdAt 时间序,status 数值序
        const sortKeyOf = (row: (typeof matched)[number]) => {
          if (input.sortBy === 'createdAt') return row.createdAt.getTime();
          if (input.sortBy === 'amount') return Number(row.amount);
          if (input.sortBy === 'status') return row.status;
          return row.id;
        };
        const av = sortKeyOf(a);
        const bv = sortKeyOf(b);
        if (av < bv) return -dir;
        if (av > bv) return dir;
        // 主序并列时 id desc 稳定决序(与 pg 适配器同口径)
        if (a.id < b.id) return 1;
        if (a.id > b.id) return -1;
        return 0;
      });
      return Promise.resolve({
        rows: sorted.slice(input.offset, input.offset + input.limit).map((row) => ({
          id: row.id,
          provider: row.provider,
          providerOrderId: row.providerOrderId,
          userId: row.userId,
          userDisplayName: row.displayName ?? null,
          userSubject: null,
          amount: row.amount,
          creditAmount: row.creditAmount,
          currency: row.currency,
          status: row.status,
          failureReason: row.failureReason ?? null,
          createdAt: row.createdAt,
          paidAt: null,
          creditedAt: null,
        })),
        total: matched.length,
      });
    },
    closeOrder: (_conn, input) => {
      // CAS 0→4 + failureReason 留痕(0 行 = 非 created 状态/不存在)
      const row = orders.get(input.orderId);
      if (!row || row.status !== 0) return Promise.resolve(false);
      row.status = 4;
      row.failureReason = input.reason;
      return Promise.resolve(true);
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
      batches.set(batchId, {
        name: input.batchName,
        remark: input.remark ?? null,
        amount: input.amount,
        total: input.codeHashes.length,
        usedCount: 0,
        createdBy: input.createdBy,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const codeIds: number[] = [];
      for (const codeHash of input.codeHashes) {
        const id = (codeSeq += 1);
        codes.set(codeHash, {
          id,
          batchId,
          status: 0,
          expiresAt: input.expiresAt,
          usedBy: null,
          usedAt: null,
        });
        codeIds.push(id);
      }
      return Promise.resolve({ batchId, codeIds });
    },
    listBatches: (_conn, input) => {
      const all = [...batches.entries()]
        .filter(([, row]) => input.q === undefined || row.name.includes(input.q))
        .toSorted((a, b) => (input.order === 'asc' ? a[0] - b[0] : b[0] - a[0]));
      return Promise.resolve({
        rows: all
          .slice(input.offset, input.offset + input.limit)
          .map(([id, row]) => ({ id, ...row })),
        total: all.length,
      });
    },
    findBatch: (_conn, batchId) => {
      const row = batches.get(batchId);
      return Promise.resolve(row ? { id: batchId, ...row } : null);
    },
    listCodes: (_conn, input) => {
      const all = [...codes.values()]
        .filter(
          (row) =>
            row.batchId === input.batchId &&
            (input.status === undefined || row.status === input.status),
        )
        .toSorted((a, b) => (input.order === 'asc' ? a.id - b.id : b.id - a.id));
      return Promise.resolve({
        rows: all.slice(input.offset, input.offset + input.limit).map((row) => {
          const { batchId: _batchId, ...rest } = row;
          void _batchId;
          return {
            ...rest,
            codeHash: [...codes.entries()].find(([, v]) => v.id === row.id)?.[0] ?? '',
          };
        }),
        total: all.length,
      });
    },
    revokeCode: (_conn, input) => {
      const row = [...codes.values()].find((candidate) => candidate.id === input.codeId);
      if (!row || row.status !== 0) return Promise.resolve(false);
      row.status = 2;
      return Promise.resolve(true);
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
