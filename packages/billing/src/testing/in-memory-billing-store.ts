/**
 * 内存版计费链路 stand-in（§5.6 类别 2）：BillingStore + SubscriptionQuotaStore +
 * ChannelExposureStore + FundingSourceResolver 的行为等价实现，供 application
 * 在无 PG 环境下的契约测试（默认门禁）；真实 PG 语义（CAS 竞态/守卫原子 UPDATE/
 * advisory lock）由 *.real.test.ts 验证。
 * requestId 为 UUID 字符串（与 PG uuid 主键同形）。
 */
import type {
  BillingRequestRow,
  BillingReservationRow,
  BillingStore,
} from '../ports/billing-store.js';
import type {
  ChannelExposureStore,
  FundingSourceResolver,
  ResolvedFundingSource,
  SubscriptionQuotaStore,
  SubscriptionSnapshot,
} from '../ports/funding-ports.js';

export interface InMemorySubscriptionRow {
  id: number;
  userId: number;
  orgId: number | null;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  status: number; // 0 有效
  endAt: Date;
}

export interface InMemoryChannelRow {
  id: number;
  upstreamBudget: string;
  upstreamReserved: string;
  upstreamThreshold: string | null;
  status: number; // 0 启用 / 3 熔断
}

export interface InMemoryBillingWorld {
  billing: BillingStore;
  quota: SubscriptionQuotaStore;
  channels: ChannelExposureStore;
  resolver: FundingSourceResolver;
  /** 直接操作测试夹具数据 */
  readonly fixtures: {
    subscriptions: Map<number, InMemorySubscriptionRow>;
    channelsMap: Map<number, InMemoryChannelRow>;
    requests: Map<string, BillingRequestRow & { appId?: number | null }>;
    settledSpend: Array<{
      userId: number;
      apiKeyId: number | null;
      subscriptionId: number | null;
      amount: string;
      at: Date;
    }>;
  };
  /** 凭证解析结果覆写（缺省：无订阅、无限额） */
  resolveOverride: Partial<ResolvedFundingSource> | null;
  /** org 成员限额覆写（key：orgId\0userId） */
  memberLimitsOverride: Map<
    string,
    { dailySpendLimit: string | null; monthlyQuota: string | null }
  >;
}

let subSeq = 0;
let chanSeq = 0;

export function createInMemoryBillingWorld(): InMemoryBillingWorld {
  const requests = new Map<string, BillingRequestRow & { appId?: number | null }>();
  const reservations: Array<BillingReservationRow & { settledAt?: Date; releasedAt?: Date }> = [];
  const subscriptions = new Map<number, InMemorySubscriptionRow>();
  const channelsMap = new Map<number, InMemoryChannelRow>();
  const settledSpend: InMemoryBillingWorld['fixtures']['settledSpend'] = [];
  const memberLimitsOverride = new Map<
    string,
    { dailySpendLimit: string | null; monthlyQuota: string | null }
  >();
  let resolveOverride: Partial<ResolvedFundingSource> | null = null;

  const conn = { connBrand: 'wallet-conn' } as const;
  const txHandle = { ...conn, txBrand: 'wallet-tx' } as const;

  const requestRow = (requestId: string): BillingRequestRow => {
    const row = requests.get(requestId);
    if (!row) throw new Error('billing.request_missing');
    return row;
  };

  const billing: BillingStore = {
    read: (fn) => fn(conn),
    transaction: (fn) => fn(txHandle),
    joinTransaction: (_tx, fn) => fn(txHandle),

    findByRequestId: (_conn, requestId) => Promise.resolve(requests.get(requestId) ?? null),

    advisoryLockAuthorizeUser: () => Promise.resolve(),

    insertAuthorized(_conn, input) {
      if (requests.has(input.requestId)) return Promise.resolve(false);
      requests.set(input.requestId, {
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        appId: null,
        channelId: null,
        channelReservedAmount: null,
        planReservedAmount: input.planReservedAmount,
        subscriptionId: input.subscriptionId,
        estimatedExposureAmount: input.estimatedExposureAmount,
        reservedAmount: input.reservedAmount,
        status: 'authorized',
        revision: 0,
        stream: input.stream,
        quote: input.quote,
        authorizationFingerprint: input.authorizationFingerprint,
        traceParent: input.traceParent,
        receipt: null,
        receiptFingerprint: null,
        leaseOwner: null,
        leaseExpiresAt: input.leaseExpiresAt,
        failureCode: null,
        settlementAttempts: 0,
        nextSettlementAt: input.nextSettlementAt,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        createdAt: input.createdAt,
      });
      return Promise.resolve(true);
    },

    casTransition(_conn, input) {
      const row = requests.get(input.requestId);
      if (!row || !(input.from as readonly string[]).includes(row.status)) {
        return Promise.resolve(false);
      }
      row.status = input.to;
      row.revision += 1;
      const set = input.set ?? {};
      if (set.receipt !== undefined) row.receipt = set.receipt;
      if (set.receiptFingerprint !== undefined) row.receiptFingerprint = set.receiptFingerprint;
      if (set.leaseExpiresAt !== undefined) row.leaseExpiresAt = set.leaseExpiresAt;
      if (set.leaseOwner !== undefined) row.leaseOwner = set.leaseOwner;
      if (set.nextSettlementAt !== undefined) row.nextSettlementAt = set.nextSettlementAt;
      if (set.failureCode !== undefined) row.failureCode = set.failureCode;
      return Promise.resolve(true);
    },

    casUpstreamStarted(_conn, input) {
      const row = requests.get(input.requestId);
      if (!row || !['authorized', 'in_flight'].includes(row.status)) {
        return Promise.resolve(false);
      }
      row.status = 'in_flight';
      row.leaseOwner = input.leaseOwner;
      row.leaseExpiresAt = input.leaseExpiresAt;
      row.revision += 1;
      return Promise.resolve(true);
    },

    casClaimChannel(_conn, input) {
      const row = requests.get(input.requestId);
      if (
        !row ||
        !(input.fromStatus as readonly string[]).includes(row.status) ||
        row.channelId !== input.expectedChannelId ||
        row.channelReservedAmount !== input.expectedReserved
      ) {
        return Promise.resolve(false);
      }
      row.channelId = input.channelId;
      row.channelReservedAmount = input.channelReservedAmount;
      row.revision += 1;
      return Promise.resolve(true);
    },

    currentStatus: (_conn, requestId) => Promise.resolve(requests.get(requestId)?.status ?? null),

    sumExposure(_conn, input) {
      let total = 0;
      for (const row of requests.values()) {
        if (
          ![
            'authorized',
            'in_flight',
            'settlement_pending',
            'processing',
            'retry_wait',
            'dead',
          ].includes(row.status)
        ) {
          continue;
        }
        if (input.userId !== undefined && row.userId !== input.userId) continue;
        if (input.apiKeyId !== undefined && row.apiKeyId !== input.apiKeyId) continue;
        if (input.subscriptionId !== undefined && row.subscriptionId !== input.subscriptionId) {
          continue;
        }
        if (input.excludeRequestId !== undefined && row.requestId === input.excludeRequestId) {
          continue;
        }
        total += Number(row.estimatedExposureAmount ?? row.reservedAmount);
      }
      return Promise.resolve(String(total));
    },

    inventory: () => {
      let pending = 0;
      let retrying = 0;
      let oldest = 0;
      const now = Date.now();
      for (const row of requests.values()) {
        if (row.status === 'settlement_pending') pending += 1;
        if (row.status === 'retry_wait') retrying += 1;
        if (row.status === 'settlement_pending' || row.status === 'retry_wait') {
          oldest = Math.max(oldest, now - row.createdAt.getTime());
        }
      }
      return Promise.resolve({ pending, retrying, oldestPendingMs: oldest });
    },

    sumSettledSpend(_conn, input) {
      let total = 0;
      for (const row of settledSpend) {
        if (row.at < input.since) continue;
        if (input.userId !== undefined && row.userId !== input.userId) continue;
        if (input.apiKeyId !== undefined && row.apiKeyId !== input.apiKeyId) continue;
        if (input.subscriptionId !== undefined && row.subscriptionId !== input.subscriptionId) {
          continue;
        }
        total += Number(row.amount);
      }
      return Promise.resolve(String(total));
    },

    insertReservation(_conn, values) {
      const id = reservations.length + 1;
      reservations.push({ id, ...values, status: 'active' });
      return Promise.resolve(id);
    },

    findActiveReservations(_conn, billingRequestId, statuses) {
      const allowed = statuses ?? [
        'authorized',
        'in_flight',
        'settlement_pending',
        'processing',
        'retry_wait',
        'dead',
      ];
      return Promise.resolve(
        reservations.filter(
          (r) =>
            r.billingRequestId === billingRequestId &&
            r.status === 'active' &&
            allowed.includes(requestRow(billingRequestId).status),
        ),
      );
    },

    markReservationReleased(_conn, id, now) {
      const row = reservations.find((r) => r.id === id && r.status === 'active');
      if (!row) return Promise.resolve(false);
      row.status = 'released';
      row.releasedAt = now;
      return Promise.resolve(true);
    },

    markReservationSettled(_conn, id, now) {
      const row = reservations.find((r) => r.id === id && r.status === 'active');
      if (!row) return Promise.resolve(false);
      row.status = 'settled';
      row.settledAt = now;
      return Promise.resolve(true);
    },

    isUniqueViolation: () => false,
  };

  const quota: SubscriptionQuotaStore = {
    activeSubscriptionSnapshot(_conn, subscriptionId, now): Promise<SubscriptionSnapshot | null> {
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

    tryReserveQuota(_conn, input) {
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

    tryReleaseQuota(_conn, input) {
      const row = subscriptions.get(input.subscriptionId);
      if (!row || Number(row.reservedAmount) < Number(input.reserved)) {
        return Promise.resolve(false);
      }
      row.reservedAmount = String(Number(row.reservedAmount) - Number(input.reserved));
      return Promise.resolve(true);
    },

    trySettleQuota(_conn, input) {
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

  const channelStore: ChannelExposureStore = {
    findChannel: (_conn, channelId) => {
      const row = channelsMap.get(channelId);
      return Promise.resolve(
        row ? { upstreamBudget: row.upstreamBudget, upstreamReserved: row.upstreamReserved } : null,
      );
    },

    tryIncreaseReserved(_conn, input) {
      const row = channelsMap.get(input.channelId);
      if (!row) return Promise.resolve(null);
      if (Number(row.upstreamBudget) - Number(row.upstreamReserved) < Number(input.delta)) {
        return Promise.resolve(null);
      }
      row.upstreamReserved = String(Number(row.upstreamReserved) + Number(input.delta));
      return Promise.resolve({ budget: row.upstreamBudget, reserved: row.upstreamReserved });
    },

    tryDecreaseReserved(_conn, input) {
      const row = channelsMap.get(input.channelId);
      if (!row || Number(row.upstreamReserved) < Number(input.amount)) {
        return Promise.resolve(false);
      }
      row.upstreamReserved = String(Number(row.upstreamReserved) - Number(input.amount));
      return Promise.resolve(true);
    },

    deductBudgetAndMaybeBreak(_conn, input) {
      const row = channelsMap.get(input.channelId);
      if (!row) return Promise.resolve(false);
      row.upstreamBudget = String(Number(row.upstreamBudget) - Number(input.upstreamCost));
      const threshold = Number(row.upstreamThreshold ?? '0');
      if (Number(row.upstreamBudget) <= threshold) {
        if (row.status === 0) row.status = 3;
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };

  const resolver: FundingSourceResolver = {
    resolve: () => {
      if (resolveOverride && 'subscriptionId' in resolveOverride) {
        return Promise.resolve({
          subscriptionId: null,
          allowPaygFallback: true,
          userDailyLimit: null,
          keyDailyLimit: null,
          ...resolveOverride,
        });
      }
      return Promise.resolve({
        subscriptionId: null,
        allowPaygFallback: true,
        userDailyLimit: null,
        keyDailyLimit: null,
        ...resolveOverride,
      });
    },
  };

  return {
    billing,
    quota,
    channels: channelStore,
    resolver,
    memberLimitsOverride,
    fixtures: { subscriptions, channelsMap, requests, settledSpend },
    get resolveOverride() {
      return resolveOverride;
    },
    set resolveOverride(value) {
      resolveOverride = value;
    },
  };
}

/** 夹具：建一条有效订阅（缺省个人、100 元额度） */
export function seedSubscription(
  world: InMemoryBillingWorld,
  overrides: Partial<InMemorySubscriptionRow> = {},
): number {
  const id = (subSeq += 1);
  world.fixtures.subscriptions.set(id, {
    id,
    userId: overrides.userId ?? 1,
    orgId: overrides.orgId ?? null,
    quotaAmount: overrides.quotaAmount ?? '100',
    usedAmount: overrides.usedAmount ?? '0',
    reservedAmount: overrides.reservedAmount ?? '0',
    status: overrides.status ?? 0,
    endAt: overrides.endAt ?? new Date(Date.now() + 86_400_000),
  });
  return id;
}

/** 夹具：建一条启用渠道（缺省 50 元预算） */
export function seedChannel(
  world: InMemoryBillingWorld,
  overrides: Partial<InMemoryChannelRow> = {},
): number {
  const id = (chanSeq += 1);
  world.fixtures.channelsMap.set(id, {
    id,
    upstreamBudget: overrides.upstreamBudget ?? '50',
    upstreamReserved: overrides.upstreamReserved ?? '0',
    upstreamThreshold: overrides.upstreamThreshold ?? null,
    status: overrides.status ?? 0,
  });
  return id;
}
