/**
 * 内存版计费链路 stand-in：BillingStore + SubscriptionQuotaStore +
 * ChannelExposureStore + FundingSourceResolver 的行为等价实现，供 application
 * 在无 PG 环境下的契约测试（默认门禁）；真实 PG 语义（CAS 竞态/守卫原子 UPDATE/
 * advisory lock）由 *.real.test.ts 验证。
 * requestId 为 UUID 字符串（与 PG uuid 主键同形）。
 * 支付/兑换族 stand-in 在 in-memory-payment-stores.ts（port 族不同，不混装）。
 */
import type {
  BillingRequestRow,
  BillingReservationRow,
  BillingStore,
} from '../ports/billing-store.js';
import type { AccountContextStore } from '../ports/account-context.js';
import type {
  ChannelExposureStore,
  FundingSourceResolver,
  ResolvedFundingSource,
  SubscriptionQuotaStore,
} from '../ports/funding-ports.js';
import { Decimal } from '../domain/money.js';
import { createInMemoryQuotaStore } from './in-memory-quota-store.js';

export interface InMemorySubscriptionRow {
  id: number;
  userId: number;
  orgId: number | null;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  status: number; // 0 有效
  endAt: Date;
  planId: number;
  quantity: number;
  price: string;
  startAt: Date;
}

export interface InMemoryChannelRow {
  id: number;
  upstreamBudget: string;
  upstreamReserved: string;
  upstreamThreshold: string | null;
  status: number; // 0 启用 / 3 熔断
}

/** plans 目录夹具行（与 port findPlan 形状一致） */
export interface InMemoryPlanRow {
  id: number;
  name: string;
  kind: string;
  sortOrder: number | null;
  price: string;
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
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
    usageLogs: Map<string, Record<string, unknown>>;
    plans: Map<number, InMemoryPlanRow>;
    knownUsers: Set<number>;
    enterpriseUsers: Set<number>;
    credentialBindings: Map<number, number>;
    operations: Map<
      string,
      {
        id: number;
        operationId: string;
        kind: string;
        fingerprint: string;
        receipt: Record<string, unknown> | null;
      }
    >;
  };
  /** 凭证解析结果覆写（缺省：无订阅、无限额） */
  resolveOverride: Partial<ResolvedFundingSource> | null;
  /** org 成员限额覆写（key：orgId\0userId） */
  memberLimitsOverride: Map<
    string,
    { dailySpendLimit: string | null; monthlyQuota: string | null }
  >;
  /** 账户侧协作 port（users/orgs/凭证改绑的内存实现） */
  accountContext: AccountContextStore;
  /**
   * 事务回滚模拟（边界测试）：全部夹具集合的深快照。与钱包 stand-in 的
   * snapshotForTest 配对，由测试的 rollbackable 事务壳在异常时一并还原——
   * 模拟 PG 的整事务回滚（内存 stand-in 本身无回滚语义）。
   */
  snapshotForTest(): BillingWorldSnapshot;
  restoreForTest(snapshot: BillingWorldSnapshot): void;
}

export interface BillingWorldSnapshot {
  requests: Array<[string, BillingRequestRow & { appId?: number | null }]>;
  reservations: Array<BillingReservationRow & { settledAt?: Date; releasedAt?: Date }>;
  subscriptions: Array<[number, InMemorySubscriptionRow]>;
  channels: Array<[number, InMemoryChannelRow]>;
  settledSpend: InMemoryBillingWorld['fixtures']['settledSpend'];
  usageLogs: Array<[string, Record<string, unknown>]>;
  plans: Array<[number, InMemoryPlanRow]>;
  operations: Array<
    [
      string,
      {
        id: number;
        operationId: string;
        kind: string;
        fingerprint: string;
        receipt: Record<string, unknown> | null;
      },
    ]
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
  const usageLogsRows = new Map<string, Record<string, unknown>>();
  const plansCatalog = new Map<
    number,
    {
      id: number;
      name: string;
      kind: string;
      sortOrder: number | null;
      price: string;
      periodDays: number;
      quotaAmount: string;
      allowSeats: boolean;
      status: number;
    }
  >();
  const operationsArchive = new Map<
    string,
    {
      id: number;
      operationId: string;
      kind: string;
      fingerprint: string;
      receipt: Record<string, unknown> | null;
    }
  >();
  let operationSeq = 0;
  let subscriptionSeq = 1000;
  let planSeq = 100;
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
      if (
        !row ||
        !(input.from as readonly string[]).includes(row.status) ||
        (input.expectLeaseOwner !== undefined && row.leaseOwner !== input.expectLeaseOwner)
      ) {
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

    async claimPending(_conn, input) {
      const claimed: Array<{
        requestId: string;
        claimToken: string;
        revision: number;
        attempt: number;
        receipt: Record<string, unknown> | null;
        traceParent: string | null;
      }> = [];
      for (const row of [...requests.values()].toSorted(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )) {
        if (claimed.length >= input.batchSize) break;
        if (row.status !== 'settlement_pending' && row.status !== 'retry_wait') continue;
        if (
          input.requestIds &&
          input.requestIds.length > 0 &&
          !input.requestIds.includes(row.requestId)
        ) {
          continue;
        }
        row.status = 'processing';
        row.revision += 1;
        row.settlementAttempts += 1;
        row.claimOwner = input.ownerId;
        row.claimToken = `token-${row.requestId}-${row.revision}`;
        row.claimUntil = new Date(Date.now() + input.claimLeaseMs);
        claimed.push({
          requestId: row.requestId,
          claimToken: row.claimToken,
          revision: row.revision,
          attempt: row.settlementAttempts,
          receipt: row.receipt,
          traceParent: row.traceParent,
        });
      }
      return claimed;
    },

    async listDueSettlementRequests(_conn, input) {
      const due = [...requests.values()]
        .filter(
          (row) =>
            (row.status === 'settlement_pending' || row.status === 'retry_wait') &&
            (row.nextSettlementAt == null || row.nextSettlementAt.getTime() <= Date.now()),
        )
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, input.limit);
      return due.map((row) => row.requestId);
    },

    renewClaims(_conn, input) {
      for (const row of requests.values()) {
        if (
          row.status === 'processing' &&
          row.claimOwner === input.ownerId &&
          input.tokens.includes(row.claimToken ?? '')
        ) {
          row.claimUntil = new Date(Date.now() + input.claimLeaseMs);
        }
      }
      return Promise.resolve();
    },

    findProcessingForClaim(_conn, claim) {
      const row = requests.get(claim.requestId);
      if (
        !row ||
        row.status !== 'processing' ||
        row.claimToken !== claim.claimToken ||
        row.claimOwner !== claim.ownerId ||
        row.revision !== claim.revision
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve(row);
    },

    casFinalizeSettled(_conn, claim) {
      const row = requests.get(claim.requestId);
      if (
        !row ||
        row.status !== 'processing' ||
        row.claimToken !== claim.claimToken ||
        row.claimOwner !== claim.ownerId ||
        row.revision !== claim.revision
      ) {
        return Promise.resolve(false);
      }
      row.status = 'settled';
      row.revision += 1;
      row.claimOwner = null;
      row.claimToken = null;
      row.claimUntil = null;
      return Promise.resolve(true);
    },

    casToRetryOrDead(_conn, claim, input) {
      const row = requests.get(claim.requestId);
      if (
        !row ||
        row.status !== 'processing' ||
        row.claimToken !== claim.claimToken ||
        row.claimOwner !== claim.ownerId ||
        row.revision !== claim.revision
      ) {
        return Promise.resolve(false);
      }
      row.status = input.dead ? 'dead' : 'retry_wait';
      row.revision += 1;
      row.claimOwner = null;
      row.claimToken = null;
      row.claimUntil = null;
      row.nextSettlementAt = input.dead ? null : new Date(Date.now() + (input.nextDelayMs ?? 0));
      return Promise.resolve(true);
    },

    listExpiredForRecovery(_conn, input) {
      const now = Date.now();
      const candidates = [...requests.values()]
        .filter(
          (row) =>
            row.status === input.status &&
            (row.leaseExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <= now,
        )
        .toSorted((a, b) => (a.leaseExpiresAt?.getTime() ?? 0) - (b.leaseExpiresAt?.getTime() ?? 0))
        .slice(0, input.limit)
        .map((row) => row.requestId);
      return Promise.resolve(candidates);
    },

    recoverOneToReleased(_conn, input) {
      const row = requests.get(input.requestId);
      if (!row || row.status !== input.status) return Promise.resolve(null);
      row.status = 'released';
      row.revision += 1;
      row.failureCode = input.failureCode;
      row.leaseExpiresAt = null;
      return Promise.resolve({
        requestId: row.requestId,
        reservedAmount: row.reservedAmount,
        channelId: row.channelId,
        channelReservedAmount: row.channelReservedAmount,
      });
    },

    requeueExpiredClaims(_conn, limit) {
      let count = 0;
      const now = Date.now();
      for (const row of requests.values()) {
        if (count >= limit) break;
        if (row.status === 'processing' && (row.claimUntil?.getTime() ?? 0) <= now) {
          row.status = 'retry_wait';
          row.revision += 1;
          row.claimOwner = null;
          row.claimToken = null;
          row.claimUntil = null;
          row.nextSettlementAt = new Date();
          count += 1;
        }
      }
      return Promise.resolve(count);
    },

    abandonOwnedClaims(_conn, ownerId) {
      let count = 0;
      for (const row of requests.values()) {
        if (row.status === 'processing' && row.claimOwner === ownerId) {
          row.status = 'retry_wait';
          row.revision += 1;
          row.claimOwner = null;
          row.claimToken = null;
          row.claimUntil = null;
          row.nextSettlementAt = new Date();
          count += 1;
        }
      }
      return Promise.resolve(count);
    },

    insertUsageLog(_conn, values) {
      const requestId = String(values.requestId);
      if (usageLogsRows.has(requestId)) return Promise.resolve(false);
      usageLogsRows.set(requestId, values);
      // 每日限额口径同步：settledSpend 追加（status=0 已结算）
      settledSpend.push({
        userId: Number(values.userId),
        apiKeyId: (values.apiKeyId as number | null) ?? null,
        subscriptionId: (values.subscriptionId as number | null) ?? null,
        amount: String(values.calculatedAmount ?? values.amount ?? '0'),
        at: new Date(),
      });
      return Promise.resolve(true);
    },

    findUsageAmount(_conn, requestId) {
      const row = usageLogsRows.get(requestId);
      return Promise.resolve(row ? String(row.calculatedAmount ?? row.amount ?? '0') : null);
    },

    isUniqueViolation: () => false,

    async findPlan(_conn, planId) {
      const plan = plansCatalog.get(planId);
      return plan ? { ...plan } : null;
    },

    async lockActiveSubscription(_conn, subscriptionId) {
      const row = subscriptions.get(subscriptionId);
      if (!row || row.status !== 0) return null;
      return { ...row };
    },

    async lockActiveSubscriptionForUser(_conn, userId, now) {
      for (const row of subscriptions.values()) {
        if (row.userId === userId && row.status === 0 && row.endAt > now) return { ...row };
      }
      return null;
    },

    async expireLapsedSubscriptions(_conn, userId, now) {
      for (const row of subscriptions.values()) {
        if (row.userId === userId && row.status === 0 && row.endAt <= now) row.status = 1;
      }
    },

    async insertSubscription(_conn, values) {
      const id = (subscriptionSeq += 1);
      subscriptions.set(id, {
        id,
        userId: values.userId,
        orgId: values.orgId,
        quotaAmount: values.quotaAmount,
        usedAmount: '0',
        reservedAmount: '0',
        status: 0,
        endAt: values.endAt,
        planId: values.planId ?? 0,
        quantity: values.quantity ?? 1,
        price: values.price ?? '0',
        startAt: values.startAt ?? new Date(),
      });
      return id;
    },

    async casSubscriptionStatus(_conn, input) {
      const row = subscriptions.get(input.subscriptionId);
      if (!row || row.status !== input.from) return false;
      row.status = input.to;
      return true;
    },

    async tryAddQuota(_conn, input) {
      const row = subscriptions.get(input.subscriptionId);
      if (!row || row.status !== 0) return false;
      row.quotaAmount = String(Number(row.quotaAmount) + Number(input.quota));
      return true;
    },

    async insertOperationPlaceholder(_conn, input) {
      if (operationsArchive.has(input.operationId)) return null;
      const id = (operationSeq += 1);
      operationsArchive.set(input.operationId, { id, ...input, receipt: null });
      return id;
    },

    async findOperation(_conn, operationId) {
      const row = operationsArchive.get(operationId);
      return row ? { ...row } : null;
    },

    // ---- 管理读侧面（stand-in;users 富化为合成值——join 语义归 pg 适配器） ----
    listAdminPlans: (_conn, query) => {
      const all = [...plansCatalog.values()]
        .filter((row) => query.q === undefined || row.name.includes(query.q))
        .toSorted((a, b) => (query.order === 'asc' ? a.id - b.id : b.id - a.id));
      return Promise.resolve({
        rows: all.slice(query.offset, query.offset + query.limit),
        total: all.length,
      });
    },
    insertPlan: (_conn, values) => {
      const id = (planSeq += 1);
      const row: InMemoryPlanRow = { id, ...values, status: 0 };
      plansCatalog.set(id, row);
      return Promise.resolve({ ...row });
    },
    patchPlan: (_conn, input) => {
      const row = plansCatalog.get(input.planId);
      if (!row) return Promise.resolve(null);
      Object.assign(row, input.patch);
      return Promise.resolve({ ...row });
    },
    deletePlan: (_conn, planId) => Promise.resolve(plansCatalog.delete(planId)),
    countSubscriptionsAnyStatus: (_conn, planId) => {
      const count = [...subscriptions.values()].filter((row) => row.planId === planId).length;
      return Promise.resolve(count);
    },
    listAdminSubscriptions: (_conn, input) => {
      const all = [...subscriptions.values()]
        .filter(
          (row) =>
            (input.planId === undefined || row.planId === input.planId) &&
            (input.userId === undefined || row.userId === input.userId) &&
            (input.status === undefined || row.status === input.status) &&
            (input.q === undefined || `user-${row.userId}`.includes(input.q)),
        )
        .toSorted((a, b) => (input.order === 'asc' ? a.id - b.id : b.id - a.id));
      const rows = all.slice(input.offset, input.offset + input.limit).map((row) => ({
        id: row.id,
        userId: row.userId,
        userSubject: `user-${row.userId}`,
        userDisplayName: null,
        planId: row.planId,
        planName: plansCatalog.get(row.planId)?.name ?? `plan-${row.planId}`,
        startAt: row.startAt,
        endAt: row.endAt,
        quotaAmount: row.quotaAmount,
        usedAmount: row.usedAmount,
        reservedAmount: row.reservedAmount,
        quantity: row.quantity,
        price: row.price,
        remainingAmount: new Decimal(row.quotaAmount)
          .minus(row.usedAmount)
          .minus(row.reservedAmount)
          .toString(),
        status: row.status,
        createdAt: row.startAt,
      }));
      return Promise.resolve({ rows, total: all.length });
    },
    listDeadCases: (_conn, input) => {
      const dead = [...requests.values()]
        .filter((row) => row.status === 'dead')
        .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve({
        rows: dead.slice(input.offset, input.offset + input.limit).map((row) => ({
          requestId: row.requestId,
          userId: row.userId,
          status: row.status,
          revision: row.revision,
          attempt: row.settlementAttempts,
          failureCode: row.failureCode,
          lastError: null,
          reservedAmount: row.reservedAmount,
          createdAt: row.createdAt,
        })),
        total: dead.length,
      });
    },
    casReviewRetryDead: (_conn, input) => {
      const row = requests.get(input.requestId);
      if (!row || row.status !== 'dead' || row.revision !== input.expectedRevision) {
        return Promise.resolve(false);
      }
      row.status = 'retry_wait';
      row.revision += 1;
      row.settlementAttempts = 0;
      row.failureCode = null;
      row.nextSettlementAt = input.now;
      return Promise.resolve(true);
    },
    casReviewAbandonDead: (_conn, input) => {
      const row = requests.get(input.requestId);
      if (!row || row.status !== 'dead' || row.revision !== input.expectedRevision) {
        return Promise.resolve(null);
      }
      row.status = 'released';
      row.revision += 1;
      return Promise.resolve({
        reservedAmount: row.reservedAmount,
        channelId: row.channelId,
        channelReservedAmount: row.channelReservedAmount,
      });
    },

    async saveOperationReceipt(_conn, id, receipt) {
      for (const row of operationsArchive.values()) {
        if (row.id === id) row.receipt = receipt;
      }
    },
  };

  const quota = createInMemoryQuotaStore({ subscriptions, memberLimitsOverride });

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

  const knownUsers = new Set<number>();
  const enterpriseUsers = new Set<number>();
  const credentialBindings = new Map<number, number>(); // credentialId -> subscriptionId（改绑语义以计数验证）
  let orgSeq = 0;
  const accountContext: AccountContextStore = {
    userExists: (_conn, userId) => Promise.resolve(knownUsers.has(userId)),
    isEnterprise: (_conn, userId) => Promise.resolve(enterpriseUsers.has(userId)),
    insertOrgWithOwner(_conn, _input) {
      orgSeq += 1;
      return Promise.resolve(orgSeq);
    },
    rebindCredentials(_conn, fromSubscriptionId, toSubscriptionId) {
      for (const [credential, bound] of credentialBindings) {
        if (bound === fromSubscriptionId) credentialBindings.set(credential, toSubscriptionId);
      }
      return Promise.resolve();
    },
  };

  return {
    billing,
    quota,
    channels: channelStore,
    resolver,
    accountContext,
    memberLimitsOverride,
    fixtures: {
      subscriptions,
      channelsMap,
      requests,
      settledSpend,
      usageLogs: usageLogsRows,
      plans: plansCatalog,
      operations: operationsArchive,
      knownUsers,
      enterpriseUsers,
      credentialBindings,
    },
    get resolveOverride() {
      return resolveOverride;
    },
    set resolveOverride(value) {
      resolveOverride = value;
    },
    snapshotForTest(): BillingWorldSnapshot {
      return {
        requests: structuredClone([...requests.entries()]),
        reservations: structuredClone(reservations),
        subscriptions: structuredClone([...subscriptions.entries()]),
        channels: structuredClone([...channelsMap.entries()]),
        settledSpend: structuredClone(settledSpend),
        usageLogs: structuredClone([...usageLogsRows.entries()]),
        plans: structuredClone([...plansCatalog.entries()]),
        operations: structuredClone([...operationsArchive.entries()]),
      };
    },
    restoreForTest(snapshot) {
      requests.clear();
      for (const [key, row] of snapshot.requests) requests.set(key, row);
      reservations.length = 0;
      reservations.push(...snapshot.reservations);
      subscriptions.clear();
      for (const [key, row] of snapshot.subscriptions) subscriptions.set(key, row);
      channelsMap.clear();
      for (const [key, row] of snapshot.channels) channelsMap.set(key, row);
      settledSpend.length = 0;
      settledSpend.push(...snapshot.settledSpend);
      usageLogsRows.clear();
      for (const [key, row] of snapshot.usageLogs) usageLogsRows.set(key, row);
      plansCatalog.clear();
      for (const [key, row] of snapshot.plans) plansCatalog.set(key, row);
      operationsArchive.clear();
      for (const [key, row] of snapshot.operations) operationsArchive.set(key, row);
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
    planId: overrides.planId ?? 1,
    quantity: overrides.quantity ?? 1,
    price: overrides.price ?? '10',
    startAt: overrides.startAt ?? new Date(),
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
