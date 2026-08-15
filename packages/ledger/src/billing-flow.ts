import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  billingRequests,
  apiKeys,
  apps,
  channels,
  orgMembers,
  users,
  usageLogs,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import {
  Decimal,
  estimateMaxCost,
  requiredReservation,
  toDecimal,
  toStorage,
} from '@ai-gateway/money';
import type {
  AuthorizeBillingCommand,
  BillingAuthorization,
  BillingEvent,
  BillingQuote,
  BillingSignalResult,
  ChannelReservationResult,
  ReserveChannelCommand,
  UsageReceipt,
} from './types.js';
import { releaseReservedAmounts } from './release.js';

export class BillingConfigurationError extends Error {
  constructor(
    public readonly code: 'invalid_quote' | 'invalid_coefficient' | 'reservation_limit_exceeded',
  ) {
    super(code);
    this.name = 'BillingConfigurationError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly userId: number,
    /** 可用信用 = settledBalance + creditLimit - reservedBalance（请求被拒时的可透支额度） */
    public readonly balance: string,
    public readonly settledBalance = balance,
    public readonly reservedBalance = '0',
    public readonly creditLimit = '0',
  ) {
    super(`insufficient balance for user ${userId}: ${balance}`);
    this.name = 'InsufficientBalanceError';
  }
}

export class BillingStateConflictError extends Error {
  constructor(
    public readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingStateConflictError';
  }
}

export class DailySpendLimitExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly dailySpendLimit: string,
    public readonly projected: string,
    /** 超限维度：user=用户级 / key=Key 级（团队团员） */
    public readonly scope: 'user' | 'key' = 'user',
    public readonly apiKeyId: number | null = null,
  ) {
    super(
      scope === 'key'
        ? `daily spend limit exceeded for key ${apiKeyId} (user ${userId})`
        : `daily spend limit exceeded for user ${userId}`,
    );
    this.name = 'DailySpendLimitExceededError';
  }
}

export class ChannelBudgetExceededError extends Error {
  constructor(
    public readonly channelId: number,
    public readonly remaining: string,
    public readonly requested: string,
  ) {
    super(`channel upstream budget exceeded for channel ${channelId}`);
    this.name = 'ChannelBudgetExceededError';
  }
}

export class SubscriptionQuotaExhaustedError extends Error {
  constructor(
    public readonly userId: number,
    public readonly remaining: string,
    public readonly requested: string,
  ) {
    super(`subscription quota exhausted for user ${userId}`);
    this.name = 'SubscriptionQuotaExhaustedError';
  }
}

/** 成员日限（a）：该成员在 org 套餐内单日封顶，硬顶 402，不溢出共享。 */
export class MemberDailyLimitExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly dailySpendLimit: string,
    public readonly projected: string,
  ) {
    super(`member daily spend limit exceeded for user ${userId}`);
    this.name = 'MemberDailyLimitExceededError';
  }
}

/** 成员子配额（b）：该成员在共享额度池中分到的额度上限，硬顶 402，不溢出共享。 */
export class MemberQuotaExceededError extends Error {
  constructor(
    public readonly userId: number,
    public readonly monthlyQuota: string,
    public readonly projected: string,
  ) {
    super(`member monthly quota exceeded for user ${userId}`);
    this.name = 'MemberQuotaExceededError';
  }
}

/** 防御：凭证绑定的订阅，用户既非 owner 也非该订阅 org 的 active 成员 → 拒绝。 */
export class SubscriptionForbiddenError extends Error {
  constructor(
    public readonly userId: number,
    public readonly subscriptionId: number,
  ) {
    super(`subscription ${subscriptionId} not allowed for user ${userId}`);
    this.name = 'SubscriptionForbiddenError';
  }
}

/** 包月 Key 无有效订阅（未订阅或已到期）：计费域隔离下仅 subscription Key 触发。 */
export class SubscriptionRequiredError extends Error {
  constructor(public readonly userId: number) {
    super(`no active subscription for user ${userId}`);
    this.name = 'SubscriptionRequiredError';
  }
}

export interface Billing {
  authorize(command: AuthorizeBillingCommand): Promise<BillingAuthorization>;
  /** 渠道「进货额度」精确硬闸：选渠前预留在途上游成本敞口（换渠道原子释放旧敞口）。 */
  reserveChannel(command: ReserveChannelCommand): Promise<ChannelReservationResult>;
  signal(event: BillingEvent): Promise<BillingSignalResult>;
}

export interface BillingDeps {
  db: Db;
  clock?: () => Date;
  admission?: {
    maxPending: number;
    maxOldestAgeMs: number;
    cacheMs: number;
  };
}

export class BillingBacklogError extends Error {
  constructor(
    public readonly pending: number,
    public readonly oldestPendingMs: number,
  ) {
    super('billing_settlement_backlog');
    this.name = 'BillingBacklogError';
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function leaseUntil(now: Date, leaseMs: number): Date {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new BillingConfigurationError('invalid_quote');
  return new Date(now.getTime() + leaseMs);
}

function calculateRequired(quote: BillingQuote, limit: string): Decimal {
  if (quote.candidates.length === 0) throw new BillingConfigurationError('invalid_quote');
  // 免费口径一致性（R6）：explicitlyFree 是「授权 0 元、不校验余额」的开关，
  // 若候选价格非全零，结算会按价格实扣——授权与结算两套口径。结构上拒绝该矛盾配置。
  if (quote.explicitlyFree) {
    const charged = quote.candidates.some((candidate) => {
      const prices = [candidate.inputPrice, candidate.outputPrice, candidate.cacheInputPrice];
      return prices.some((price) => toDecimal(price).gt(0));
    });
    if (charged) throw new BillingConfigurationError('invalid_quote');
    return new Decimal(0);
  }

  let maximum = new Decimal(0);
  for (const candidate of quote.candidates) {
    const coefficient = toDecimal(candidate.coefficient);
    const prices = [
      toDecimal(candidate.inputPrice),
      toDecimal(candidate.outputPrice),
      toDecimal(candidate.cacheInputPrice),
    ];
    if (!coefficient.isFinite() || coefficient.lte(0)) {
      throw new BillingConfigurationError('invalid_coefficient');
    }
    if (prices.some((price) => !price.isFinite() || price.lt(0))) {
      throw new BillingConfigurationError('invalid_quote');
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidate.inputTokenUpperBound,
      maxOutputTokens: quote.maxOutputTokens,
      inputPrice: candidate.inputPrice,
      cacheInputPrice: candidate.cacheInputPrice,
      outputPrice: candidate.outputPrice,
      coefficient,
    });
    if (estimate.gt(maximum)) maximum = estimate;
  }
  if (maximum.lte(0)) throw new BillingConfigurationError('invalid_quote');
  try {
    return requiredReservation(maximum, limit);
  } catch (error) {
    if ((error as Error).message === 'reservation_limit_exceeded') {
      throw new BillingConfigurationError('reservation_limit_exceeded');
    }
    throw new BillingConfigurationError('invalid_quote');
  }
}

export function validateReceipt(userId: number, quote: BillingQuote, receipt: UsageReceipt): void {
  if (receipt.userId !== userId) throw new Error('billing_receipt_user_mismatch');
  if (receipt.usage.estimated) throw new Error('billing_receipt_estimated_usage');
  const usageValues = [
    receipt.usage.inputTokens,
    receipt.usage.cachedInputTokens,
    receipt.usage.outputTokens,
    receipt.durationMs,
  ];
  if (usageValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('billing_receipt_invalid_usage');
  }
  if (
    !Number.isInteger(receipt.usage.inputTokens) ||
    !Number.isInteger(receipt.usage.cachedInputTokens) ||
    !Number.isInteger(receipt.usage.outputTokens) ||
    receipt.usage.cachedInputTokens > receipt.usage.inputTokens
  ) {
    throw new Error('billing_receipt_invalid_usage');
  }
  const authorized = quote.candidates.some(
    (item) =>
      item.mappingId === receipt.mappingId &&
      item.externalModel === receipt.externalModel &&
      item.realModel === receipt.realModel &&
      toDecimal(item.inputPrice).eq(receipt.inputPrice) &&
      toDecimal(item.outputPrice).eq(receipt.outputPrice) &&
      toDecimal(item.cacheInputPrice).eq(receipt.cacheInputPrice) &&
      toDecimal(item.coefficient).eq(receipt.coefficient) &&
      item.billingPolicyFingerprint === receipt.billingPolicyFingerprint,
  );
  if (!authorized) throw new Error('billing_receipt_not_authorized');
  // 06 修复：收据校验不再用「字节数上界 vs 真实 token 数」判死。
  // 供应商 token 化与请求体字节数之间不存在可靠的硬上界关系（MiniMax 会报告隐藏的
  // system/cached token，inputTokens 可远超字节数），用字节数卡 token 会把正常订单误判 dead。
  // 真正的资损不变量是「金额」：settleClaim 的 `calculated > reserved → invariant_violation`
  // 已确保绝不超预扣扣款，无需在此处重复用 token 计数设防。
}

/**
 * 企业计费门面。PostgreSQL 是唯一事实源；队列只发送 requestId 唤醒结算处理器。
 */
export function createBilling({ db, clock = () => new Date(), admission }: BillingDeps): Billing {
  let admissionCache: { expiresAt: number; pending: number; oldestPendingMs: number } | undefined;
  let admissionProbe: Promise<{ pending: number; oldestPendingMs: number }> | undefined;

  async function assertSettlementCapacity(): Promise<void> {
    if (!admission) return;
    const nowMs = Date.now();
    let state = admissionCache && admissionCache.expiresAt > nowMs ? admissionCache : undefined;
    if (!state) {
      admissionProbe ??= db
        .execute<{ pending: string; oldest_pending_at: Date | string | null }>(sql`
          select
            count(*)::text as pending,
            min(created_at) as oldest_pending_at
          from billing_requests
          where status in ('settlement_pending','processing','retry_wait')
        `)
        .then((result) => {
          const row = result.rows[0];
          const oldestPendingMs = row?.oldest_pending_at
            ? Math.max(0, Date.now() - new Date(row.oldest_pending_at).getTime())
            : 0;
          const value = { pending: Number(row?.pending ?? 0), oldestPendingMs };
          admissionCache = { ...value, expiresAt: Date.now() + admission.cacheMs };
          return value;
        })
        .finally(() => {
          admissionProbe = undefined;
        });
      state = { ...(await admissionProbe), expiresAt: Date.now() + admission.cacheMs };
    }
    if (
      state.pending >= admission.maxPending ||
      state.oldestPendingMs >= admission.maxOldestAgeMs
    ) {
      throw new BillingBacklogError(state.pending, state.oldestPendingMs);
    }
  }

  return {
    async authorize(command) {
      await assertSettlementCapacity();
      const amount = toStorage(calculateRequired(command.quote, command.reservationLimit));
      const fp = fingerprint({
        requestId: command.requestId,
        userId: command.userId,
        apiKeyId: command.apiKeyId ?? null,
        stream: command.stream,
        quote: command.quote,
        amount,
      });
      const now = clock();
      const result = await db.transaction(async (tx) => {
        // 每日花费上限（防羊毛党「细水长流」）：当日已结算消费 + 在途敞口 + 本次预估 不得超过。
        // RPM/TPM 只挡频率，这里挡「每日总量」。
        const profile = await tx.query.users.findFirst({
          where: eq(users.id, command.userId),
          columns: { dailySpendLimit: true },
        });
        if (profile && profile.dailySpendLimit !== null) {
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          // 已结算消费按 usage_logs.amount 统计（含套餐+余额，与 Key 级口径统一）：
          // 套餐覆盖的消耗不再写 consume 流水，改用 usage_logs 才能正确计入「单日总价值消耗」。
          const spentRow = await tx.execute<{ total: string }>(sql`
            select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
            from ${usageLogs}
            where ${usageLogs.userId} = ${command.userId}
              and ${usageLogs.status} = 0
              and ${usageLogs.createdAt} >= ${todayStart}
          `);
          const exposureRow = await tx.execute<{ total: string }>(sql`
            select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
            from ${billingRequests}
            where ${billingRequests.userId} = ${command.userId}
              and ${billingRequests.createdAt} >= ${todayStart}
              and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','uncertain','dead')
          `);
          const projected = toDecimal(spentRow.rows[0]?.total ?? '0')
            .plus(toDecimal(exposureRow.rows[0]?.total ?? '0'))
            .plus(toDecimal(amount));
          if (projected.gt(profile.dailySpendLimit)) {
            throw new DailySpendLimitExceededError(
              command.userId,
              profile.dailySpendLimit,
              projected.toString(),
            );
          }
        }

        // Key 级每日花费上限（团队团员单 Key 单日封顶）：与用户级独立，两者都设时双闸门。
        // 同时读订阅绑定（单一真相）：authorize 据此分流，不信任调用方传参。
        let subscriptionId: number | null = null;
        if (command.apiKeyId != null) {
          const key = await tx.query.apiKeys.findFirst({
            where: eq(apiKeys.id, command.apiKeyId),
            columns: { dailySpendLimit: true, subscriptionId: true },
          });
          if (key) subscriptionId = key.subscriptionId;
          if (key && key.dailySpendLimit !== null) {
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            // 已结算：该 Key 今日 consume 流水（usage_logs 按 apiKeyId 关联，amount 为实际扣费）
            const keySpentRow = await tx.execute<{ total: string }>(sql`
              select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
              from ${usageLogs}
              where ${usageLogs.apiKeyId} = ${command.apiKeyId}
                and ${usageLogs.status} = 0
                and ${usageLogs.createdAt} >= ${todayStart}
            `);
            // 在途敞口：该 Key 今日未终结请求的预估
            const keyExposureRow = await tx.execute<{ total: string }>(sql`
              select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
              from ${billingRequests}
              where ${billingRequests.apiKeyId} = ${command.apiKeyId}
                and ${billingRequests.createdAt} >= ${todayStart}
                and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','uncertain','dead')
            `);
            const keyProjected = toDecimal(keySpentRow.rows[0]?.total ?? '0')
              .plus(toDecimal(keyExposureRow.rows[0]?.total ?? '0'))
              .plus(toDecimal(amount));
            if (keyProjected.gt(key.dailySpendLimit)) {
              throw new DailySpendLimitExceededError(
                command.userId,
                key.dailySpendLimit,
                keyProjected.toString(),
                'key',
                command.apiKeyId,
              );
            }
          }
        } else if (command.appId != null) {
          // JWT/App 凭证：读 apps.subscription_id（单一真相）。
          const app = await tx.query.apps.findFirst({
            where: eq(apps.id, command.appId),
            columns: { subscriptionId: true },
          });
          if (app) subscriptionId = app.subscriptionId;
        }

        // 计费来源（单一真相 = 凭证绑定的 subscription_id）：NULL=余额，非空=该订阅额度。
        const amountDec = toDecimal(amount);
        let planReservedAmount: string | null = null;

        if (subscriptionId != null) {
          // 订阅来源：读订阅行 + 防御校验（owner 或 active 成员）+ 成员上限 a/b。
          const sub = await tx.query.userSubscriptions.findFirst({
            where: and(
              eq(userSubscriptions.id, subscriptionId),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, now),
            ),
            columns: {
              id: true,
              userId: true,
              orgId: true,
              quotaAmount: true,
              usedAmount: true,
              reservedAmount: true,
            },
          });
          if (!sub) throw new SubscriptionRequiredError(command.userId);

          // 防御校验：用户 = 订阅 owner，或该订阅 org 的 active 成员；否则拒绝（防绑到别人套餐）。
          let allowed = sub.userId === command.userId;
          if (!allowed && sub.orgId != null) {
            const member = await tx.query.orgMembers.findFirst({
              where: and(
                eq(orgMembers.orgId, sub.orgId),
                eq(orgMembers.userId, command.userId),
                eq(orgMembers.status, 0),
              ),
              columns: { dailySpendLimit: true, monthlyQuota: true },
            });
            if (member) {
              allowed = true;
              // 成员日限 a：该成员在 org 套餐内单日封顶（硬顶，不溢出共享）。
              if (member.dailySpendLimit != null) {
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const spent = await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
                  from ${usageLogs}
                  where ${usageLogs.userId} = ${command.userId}
                    and ${usageLogs.subscriptionId} = ${subscriptionId}
                    and ${usageLogs.status} = 0
                    and ${usageLogs.createdAt} >= ${todayStart}
                `);
                const exposure = await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
                  from ${billingRequests}
                  where ${billingRequests.userId} = ${command.userId}
                    and ${billingRequests.subscriptionId} = ${subscriptionId}
                    and ${billingRequests.createdAt} >= ${todayStart}
                    and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','uncertain','dead')
                `);
                const projected = toDecimal(spent.rows[0]?.total ?? '0')
                  .plus(toDecimal(exposure.rows[0]?.total ?? '0'))
                  .plus(amountDec);
                if (projected.gt(member.dailySpendLimit)) {
                  throw new MemberDailyLimitExceededError(
                    command.userId,
                    member.dailySpendLimit,
                    projected.toString(),
                  );
                }
              }
              // 成员子配额 b：该成员在共享额度池中分到的额度上限（硬顶，不溢出共享）。
              if (member.monthlyQuota != null) {
                const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                const spent = await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(${usageLogs.amount}), 0)::numeric as total
                  from ${usageLogs}
                  where ${usageLogs.userId} = ${command.userId}
                    and ${usageLogs.subscriptionId} = ${subscriptionId}
                    and ${usageLogs.status} = 0
                    and ${usageLogs.createdAt} >= ${monthStart}
                `);
                const exposure = await tx.execute<{ total: string }>(sql`
                  select coalesce(sum(${billingRequests.reservedAmount}), 0)::numeric as total
                  from ${billingRequests}
                  where ${billingRequests.userId} = ${command.userId}
                    and ${billingRequests.subscriptionId} = ${subscriptionId}
                    and ${billingRequests.createdAt} >= ${monthStart}
                    and ${billingRequests.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','uncertain','dead')
                `);
                const projected = toDecimal(spent.rows[0]?.total ?? '0')
                  .plus(toDecimal(exposure.rows[0]?.total ?? '0'))
                  .plus(amountDec);
                if (projected.gt(member.monthlyQuota)) {
                  throw new MemberQuotaExceededError(
                    command.userId,
                    member.monthlyQuota,
                    projected.toString(),
                  );
                }
              }
            }
          }
          if (!allowed) throw new SubscriptionForbiddenError(command.userId, subscriptionId);

          const remaining = toDecimal(sub.quotaAmount)
            .minus(toDecimal(sub.usedAmount))
            .minus(toDecimal(sub.reservedAmount));
          // 额度硬顶：预估超出剩余额度 → 402（套餐额度永不为负）。
          if (remaining.lt(amountDec)) {
            throw new SubscriptionQuotaExhaustedError(command.userId, remaining.toString(), amount);
          }
          planReservedAmount = amount;
        } else {
          // 余额来源：只扣余额（含信用透支）。可用信用 = balance + credit_limit − reserved。
          // 0 元（免费模型）不校验余额（fast-path 见下）。
          const user = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true, creditLimit: true },
          });
          if (!user) throw new InsufficientBalanceError(command.userId, '0');
          const available = toDecimal(user.balance)
            .plus(user.creditLimit)
            .minus(user.reservedBalance);
          if (!amountDec.isZero() && available.lt(amountDec)) {
            throw new InsufficientBalanceError(
              command.userId,
              available.toString(),
              user.balance,
              user.reservedBalance,
              user.creditLimit,
            );
          }
        }

        const inserted = await tx
          .insert(billingRequests)
          .values({
            requestId: command.requestId,
            userId: command.userId,
            apiKeyId: command.apiKeyId ?? null,
            reservedAmount: amount,
            planReservedAmount,
            subscriptionId,
            status: 'authorized',
            stream: command.stream,
            quote: command.quote as unknown as Record<string, unknown>,
            authorizationFingerprint: fp,
            traceParent: command.traceParent ?? null,
            leaseExpiresAt: leaseUntil(now, command.authorizationTtlMs),
            nextSettlementAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: billingRequests.requestId })
          .returning({ requestId: billingRequests.requestId });

        if (inserted.length === 0) {
          const existing = await tx.query.billingRequests.findFirst({
            where: eq(billingRequests.requestId, command.requestId),
          });
          if (
            !existing ||
            existing.authorizationFingerprint !== fp ||
            existing.userId !== command.userId ||
            !toDecimal(existing.reservedAmount).eq(amount)
          ) {
            throw new BillingStateConflictError(command.requestId, 'authorization replay conflict');
          }
          const user = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true, creditLimit: true },
          });
          if (!user) throw new InsufficientBalanceError(command.userId, '0');
          return {
            settledBalance: user.balance,
            reservedBalance: user.reservedBalance,
            availableBalance: toStorage(
              toDecimal(user.balance).plus(user.creditLimit).minus(user.reservedBalance),
            ),
            replayed: true,
          };
        }

        if (amountDec.isZero()) {
          // 免费模型 fast-path：不预留、不落余额动作（billing_requests 已落行供链路观测）。
          const user = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true, creditLimit: true },
          });
          if (!user) throw new InsufficientBalanceError(command.userId, '0');
          return {
            settledBalance: user.balance,
            reservedBalance: user.reservedBalance,
            availableBalance: toStorage(
              toDecimal(user.balance).plus(user.creditLimit).minus(user.reservedBalance),
            ),
            replayed: false,
          };
        }

        if (subscriptionId != null) {
          // 预占套餐额度（硬闸原子校验），无余额兜底。
          const subUpdated = await tx
            .update(userSubscriptions)
            .set({
              reservedAmount: sql`${userSubscriptions.reservedAmount} + ${planReservedAmount!}::numeric`,
            })
            .where(
              and(
                eq(userSubscriptions.id, subscriptionId!),
                sql`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount} >= ${planReservedAmount!}::numeric`,
              ),
            )
            .returning({ id: userSubscriptions.id });
          if (subUpdated.length === 0) {
            throw new SubscriptionQuotaExhaustedError(command.userId, '0', amount);
          }
        } else {
          // 预占余额在途敞口（硬闸原子校验）：可用信用 = balance + credit_limit − reserved_balance。
          const reserved = await tx
            .update(users)
            .set({
              reservedBalance: sql`${users.reservedBalance} + ${amount}::numeric`,
              updatedAt: now,
            })
            .where(
              and(
                eq(users.id, command.userId),
                sql`${users.balance} + ${users.creditLimit} - ${users.reservedBalance} >= ${amount}::numeric`,
              ),
            )
            .returning({
              balance: users.balance,
              reservedBalance: users.reservedBalance,
              creditLimit: users.creditLimit,
            });
          if (reserved.length === 0) {
            throw new InsufficientBalanceError(command.userId, '0', '0', '0', '0');
          }
        }

        const userRow = await tx.query.users.findFirst({
          where: eq(users.id, command.userId),
          columns: { balance: true, reservedBalance: true, creditLimit: true },
        });
        if (!userRow) throw new InsufficientBalanceError(command.userId, '0');
        return {
          settledBalance: userRow.balance,
          reservedBalance: userRow.reservedBalance,
          availableBalance: toStorage(
            toDecimal(userRow.balance)
              .plus(userRow.creditLimit)
              .minus(userRow.reservedBalance),
          ),
          replayed: false,
        };
      });
      return {
        requestId: command.requestId,
        reservedAmount: amount,
        settledBalance: result.settledBalance,
        reservedBalance: result.reservedBalance,
        availableBalance: result.availableBalance,
        replayed: result.replayed,
      };
    },

    async reserveChannel(command) {
      const now = clock();
      const amount = toDecimal(command.amount);
      if (!amount.isFinite() || amount.lt(0)) {
        throw new BillingConfigurationError('invalid_quote');
      }
      return db.transaction(async (tx) => {
        const br = await tx.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, command.requestId),
          columns: {
            status: true,
            channelId: true,
            channelReservedAmount: true,
          },
        });
        if (!br) {
          throw new BillingStateConflictError(command.requestId, 'billing request missing');
        }
        if (!['authorized', 'in_flight'].includes(br.status)) {
          return { allowed: false, remaining: '0', switched: false };
        }
        // 同一渠道重复预留（幂等）：已预留过则直接放行
        if (br.channelId === command.channelId && br.channelReservedAmount != null) {
          return { allowed: true, remaining: '0', switched: false };
        }

        // 目标渠道：按「余额 = 进货额度（当前余额，结算已扣减）- 在途敞口」校验是否有钱（所有渠道统一）。
        // 此读仅为快速路径与提示信息；权威闸门在下方 UPDATE 的 WHERE（R4：check-then-act 并发超扣）。
        const ch = await tx.query.channels.findFirst({
          where: eq(channels.id, command.channelId),
          columns: { upstreamBudget: true, upstreamReserved: true },
        });
        if (!ch) return { allowed: false, remaining: '0', switched: false };
        const remaining = toDecimal(ch.upstreamBudget).minus(toDecimal(ch.upstreamReserved));
        if (remaining.lt(amount)) {
          // 余额不足 → 拒绝；不释放旧渠道敞口（保持可回退，最终失败由 signal 释放）
          return { allowed: false, remaining: remaining.toString(), switched: false };
        }

        // 余额足够 → 换渠道（fallback）时先释放旧渠道敞口，再预留新渠道
        let switched = false;
        if (
          br.channelId != null &&
          br.channelId !== command.channelId &&
          br.channelReservedAmount != null
        ) {
          const released = await tx
            .update(channels)
            .set({
              upstreamReserved: sql`${channels.upstreamReserved} - ${br.channelReservedAmount}::numeric`,
              updatedAt: now,
            })
            .where(
              sql`${channels.id} = ${br.channelId}
                  and ${channels.upstreamReserved} >= ${br.channelReservedAmount}::numeric`,
            )
            .returning({ id: channels.id });
          if (released.length === 0) throw new Error('channel_reservation_invariant');
          switched = true;
        }

        // 原子预留：余额守卫必须内联在 UPDATE 的 WHERE——并发对手在检查与写入之间
        // 占走余额时此条件更新命中 0 行 → 拒绝（整个事务原子回退，敞口不会虚增）。
        const reservedNow = await tx
          .update(channels)
          .set({
            upstreamReserved: sql`${channels.upstreamReserved} + ${amount.toString()}::numeric`,
            updatedAt: now,
          })
          .where(
            sql`${channels.id} = ${command.channelId}
                and ${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${amount.toString()}::numeric`,
          )
          .returning({
            budget: channels.upstreamBudget,
            reserved: channels.upstreamReserved,
          });
        if (reservedNow.length === 0) {
          return { allowed: false, remaining: '0', switched: false };
        }
        // 状态守卫：账单必须仍在可预留状态。与过期回收（recoverOnce）竞态时，
        // 终态行上不得落渠道敞口——0 行命中则抛错回滚整个事务（含上面的敞口递增）。
        const claimed = await tx
          .update(billingRequests)
          .set({
            channelId: command.channelId,
            channelReservedAmount: amount.toString(),
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, command.requestId),
              inArray(billingRequests.status, ['authorized', 'in_flight']),
            ),
          )
          .returning({ requestId: billingRequests.requestId });
        if (claimed.length === 0) {
          throw new BillingStateConflictError(command.requestId, 'reserve target not reservable');
        }
        const remainingAfter = toDecimal(reservedNow[0]!.budget).minus(
          toDecimal(reservedNow[0]!.reserved),
        );
        return { allowed: true, remaining: remainingAfter.toString(), switched };
      });
    },

    async signal(event) {
      const now = clock();
      if (event.type === 'upstream.started') {
        const changed = await db
          .update(billingRequests)
          .set({
            status: 'in_flight',
            revision: sql`${billingRequests.revision} + 1`,
            leaseOwner: event.leaseOwner,
            leaseExpiresAt: leaseUntil(now, event.leaseMs),
            upstreamStartedAt: sql`coalesce(${billingRequests.upstreamStartedAt}, ${now})`,
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, event.requestId),
              inArray(billingRequests.status, ['authorized', 'in_flight']),
            ),
          )
          .returning({ status: billingRequests.status });
        if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
      } else if (event.type === 'lease.renewed') {
        const changed = await db
          .update(billingRequests)
          .set({ leaseExpiresAt: leaseUntil(now, event.leaseMs), updatedAt: now })
          .where(
            and(
              eq(billingRequests.requestId, event.requestId),
              eq(billingRequests.status, 'in_flight'),
              eq(billingRequests.leaseOwner, event.leaseOwner),
            ),
          )
          .returning({ status: billingRequests.status });
        if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
      } else if (event.type === 'request.succeeded') {
        if (event.receipt.requestId !== event.requestId) {
          throw new BillingStateConflictError(event.requestId, 'receipt requestId mismatch');
        }
        const receiptFp = fingerprint(event.receipt);
        const authorized = await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, event.requestId),
          columns: {
            userId: true,
            quote: true,
            status: true,
            receiptFingerprint: true,
          },
        });
        if (!authorized) {
          throw new BillingStateConflictError(event.requestId, 'billing request missing');
        }
        if (
          ['settlement_pending', 'settled'].includes(authorized.status) &&
          authorized.receiptFingerprint === receiptFp
        ) {
          return { changed: false, status: authorized.status, replayed: true };
        }
        if (!['authorized', 'in_flight', 'uncertain'].includes(authorized.status)) {
          throw new BillingStateConflictError(
            event.requestId,
            'receipt conflicts with billing state',
          );
        }
        validateReceipt(
          authorized.userId,
          authorized.quote as unknown as BillingQuote,
          event.receipt,
        );
        const changed = await db
          .update(billingRequests)
          .set({
            status: 'settlement_pending',
            revision: sql`${billingRequests.revision} + 1`,
            receipt: event.receipt as unknown as Record<string, unknown>,
            receiptFingerprint: receiptFp,
            leaseExpiresAt: null,
            nextSettlementAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, event.requestId),
              inArray(billingRequests.status, ['authorized', 'in_flight', 'uncertain']),
            ),
          )
          .returning({ status: billingRequests.status });
        if (changed.length > 0) {
          return { changed: true, status: 'settlement_pending', replayed: false };
        }
        const existing = await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, event.requestId),
          columns: { status: true, receiptFingerprint: true },
        });
        if (
          existing &&
          ['settlement_pending', 'settled'].includes(existing.status) &&
          existing.receiptFingerprint === receiptFp
        ) {
          return { changed: false, status: existing.status, replayed: true };
        }
        throw new BillingStateConflictError(
          event.requestId,
          'receipt conflicts with billing state',
        );
      } else if (event.type === 'request.uncertain') {
        const uncertain = await db
          .update(billingRequests)
          .set({
            status: 'uncertain',
            revision: sql`${billingRequests.revision} + 1`,
            failureCode: event.reason.slice(0, 64),
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, event.requestId),
              eq(billingRequests.status, 'in_flight'),
            ),
          )
          .returning({ requestId: billingRequests.requestId });
        if (uncertain.length > 0) {
          return { changed: true, status: 'uncertain', replayed: false };
        }
      } else {
        if (event.upstreamCharge === 'unknown') {
          const uncertain = await db
            .update(billingRequests)
            .set({
              status: 'uncertain',
              revision: sql`${billingRequests.revision} + 1`,
              failureCode: event.reason.slice(0, 64),
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(billingRequests.requestId, event.requestId),
                eq(billingRequests.status, 'in_flight'),
              ),
            )
            .returning({ requestId: billingRequests.requestId });
          if (uncertain.length > 0) {
            return { changed: true, status: 'uncertain', replayed: false };
          }
        }
        const released = await db.transaction(async (tx) => {
          const row = await tx
            .update(billingRequests)
            .set({
              status: 'released',
              revision: sql`${billingRequests.revision} + 1`,
              failureCode: event.reason.slice(0, 64),
              leaseExpiresAt: null,
              releasedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(billingRequests.requestId, event.requestId),
                event.upstreamCharge === 'none'
                  ? inArray(billingRequests.status, ['authorized', 'in_flight'])
                  : eq(billingRequests.status, 'authorized'),
              ),
            )
            .returning({
              userId: billingRequests.userId,
              reservedAmount: billingRequests.reservedAmount,
              planReservedAmount: billingRequests.planReservedAmount,
              subscriptionId: billingRequests.subscriptionId,
              channelId: billingRequests.channelId,
              channelReservedAmount: billingRequests.channelReservedAmount,
            });
          if (row.length === 0) return null;
          // 三类预扣投影同步释放（余额在途/套餐在途/渠道在途）——唯一实现见 release.ts。
          // R1 回归：此处曾遗漏余额部分，导致 PAYG 预占永久冻结。
          await releaseReservedAmounts(tx, row[0]!, (dimension) => {
            throw new Error(`${dimension}_reservation_invariant`);
          });
          return row[0]!;
        });
        if (released) {
          return { changed: true, status: 'released', replayed: false };
        }
      }

      const existing = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, event.requestId),
        columns: { status: true },
      });
      if (!existing)
        throw new BillingStateConflictError(event.requestId, 'billing request missing');
      if (event.type === 'upstream.started' && existing.status !== 'in_flight') {
        throw new BillingStateConflictError(
          event.requestId,
          `upstream start rejected in billing state ${existing.status}`,
        );
      }
      return { changed: false, status: existing.status, replayed: true };
    },
  };
}

export function newLeaseOwner(): string {
  return randomUUID();
}
