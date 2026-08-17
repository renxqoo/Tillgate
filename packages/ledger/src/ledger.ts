import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  apiKeys,
  apps,
  fundOperations,
  orgMembers,
  organizations,
  paymentOrders,
  plans,
  redeemBatches,
  redeemCodes,
  transactions,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal, toDecimal, toStorage } from '@ai-gateway/money';
import { reconcileAll, reconcileUsageVsTransactions, reconcileUser } from './billing/reconcile/index.js';
import type { SettleResult, UsageReceipt } from './billing/types.js';
import type { Redis } from 'ioredis';
import { backfillTpm } from './billing/settle/index.js';

export type MoneyInput = string | Decimal;

export interface LedgerAuditEvent {
  adminId?: number | null;
  actor?: 'admin' | 'system';
  action: string;
  targetType: string;
  targetId?: string | number | null;
  detail?: Record<string, unknown> | null;
}

export interface LedgerEffects {
  balanceChanged?(event: { userId: number; balanceAfter?: string }): Promise<void>;
  audit?(event: LedgerAuditEvent): Promise<void>;
  usageSettled?(event: { data: UsageReceipt; result: SettleResult }): Promise<void>;
}

export interface LedgerDeps {
  db: Db;
  effects?: LedgerEffects;
  clock?: () => Date;
}

/** Redis 只承载提交后的缓存失效与 TPM 回填，不参与资金事务。 */
export function createRedisLedgerEffects(redis: Redis): LedgerEffects {
  return {
    async balanceChanged({ userId }) {
      await redis.del(`billing:balance:${userId}`);
    },
    async usageSettled({ data }) {
      await backfillTpm(redis, data);
    },
  };
}

export interface BalanceMutationResult {
  transactionId: number;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export type SignupGiftResult =
  | ({ granted: true } & BalanceMutationResult)
  | { granted: false; reason: 'already_granted' | 'not_eligible' };

/**
 * 兑换结果（含拒绝）。注意：拒绝是「可落库重放的领域事实」——rejected 会写入
 * fund_operations.result，重试按幂等回执重放同一拒绝；改抛异常会回滚事务丢失
 * 回执（重试将重新 claim 而非重放）。因此此处保留结果联合，不做抛式改造。
 */
export type RedeemResult =
  | ({ ok: true; codeId: number } & BalanceMutationResult)
  | {
      ok: false;
      reason: 'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired';
    };

export interface SubscribeResult {
  userId: number;
  subscriptionId: number;
  /** 团队套餐购买/续费/变更时挂靠的组织（T3：org 在账本事务内创建/复用） */
  orgId: number | null;
  planId: number;
  planName: string;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  price: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'user_not_found'
      | 'insufficient_balance'
      | 'invalid_amount'
      | 'idempotency_conflict'
      | 'already_subscribed'
      | 'plan_not_found'
      | 'plan_disabled'
      | 'no_subscription'
      | 'downgrade_not_allowed'
      | 'invalid_quantity'
      | 'not_a_pack'
      | 'seats_not_allowed'
      | 'enterprise_required'
      | 'plan_not_purchasable'
      | 'subscription_inactive',
    message: string = code,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface PaymentCreditResult {
  ok: boolean;
  transactionId?: number;
  amount?: string;
  balanceAfter?: string;
  replayed: boolean;
}

export interface PaymentRefundResult {
  ok: boolean;
  transactionId?: number;
  amount?: string;
  balanceAfter?: string;
  replayed: boolean;
}

export interface Ledger {
  getBalance(userId: number): Promise<string>;
  adminGift(input: {
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult>;
  adminAdjust(input: {
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult>;
  grantSignupGift(input: { userId: number; amount: MoneyInput }): Promise<SignupGiftResult>;
  redeemCode(input: { userId: number; code: string }): Promise<RedeemResult>;
  /** 在线支付入账（幂等：operationId=payment-credit:{provider}:{providerOrderId}） */
  paymentCredit(input: {
    provider: 'epay' | 'stripe';
    providerOrderId: string;
    paymentOrderId: string;
    userId: number;
    amount: MoneyInput;
    creditAmount: MoneyInput;
  }): Promise<PaymentCreditResult>;
  /** 在线支付退款（余额守卫；幂等：payment-refund:{providerOrderId}） */
  paymentRefund(input: {
    provider: 'epay' | 'stripe';
    providerOrderId: string;
    paymentOrderId: string;
    userId: number;
    amount: MoneyInput;
  }): Promise<PaymentRefundResult>;
  /** 定向营销入账（邀请奖励/返佣共用；幂等键自然来自 operationId） */
  grantPromotionalCredit(input: {
    operationId: string;
    userId: number;
    amount: MoneyInput;
    kind: 'referral_signup' | 'referral_commission';
    refId: string;
    remark?: string;
  }): Promise<BalanceMutationResult>;
  /** 购买套餐：扣余额、开新订阅期（已有有效订阅则拒绝）。quantity=席位（默认 1）。
   *  orgId 非空 = 组织订阅（企业团队套餐，user_id=owner）。 */
  subscribePlan(input: {
    operationId: string;
    userId: number;
    planId: number;
    quantity?: number;
    orgId?: number | null;
    /** true = 团队套餐购买时在账本事务内「复用或创建」组织（T3：org 不再由路由层预建） */
    ensureOrg?: boolean;
    adminId?: number | null;
  }): Promise<SubscribeResult>;
  /** 续费指定订阅：按原席位扣余额、旧订阅转到期、新订阅期顺延（到期后可再续）。
   *  userId 传入时校验订阅归属（用户自助）；不传为管理员操作（不限归属）。 */
  renewSubscription(input: {
    operationId: string;
    subscriptionId: number;
    userId?: number | null;
    adminId?: number | null;
  }): Promise<SubscribeResult>;
  /** 变更订阅（升档/加席位）：只能升不能降，补差价 = max(0, 新总价 - 剩余价值)。
   *  userId 传入时校验订阅归属（用户自助）；不传为管理员操作（不限归属）。 */
  changeSubscription(input: {
    operationId: string;
    subscriptionId: number;
    targetPlanId: number;
    quantity: number;
    userId?: number | null;
    adminId?: number | null;
  }): Promise<SubscribeResult>;
  /** 发放加油包：扣 pack.price、有效订阅额度 += pack.quota_amount（管理员触发，不透支）。 */
  grantPack(input: {
    operationId: string;
    userId: number;
    packId: number;
    adminId?: number | null;
  }): Promise<SubscribeResult>;
  /** 取消订阅：剩余额度作废，不退款。 */
  cancelSubscription(input: {
    operationId: string;
    subscriptionId: number;
    adminId?: number | null;
  }): Promise<{ subscriptionId: number; replayed: boolean }>;
  reconcile(input?: {
    scope?: 'all' | 'user' | 'usage';
    userId?: number;
    recentDays?: number;
  }): Promise<{ checkedUsers: number; checkedChannels?: number; discrepancies: number }>;
}

type StoredMutation = Omit<BalanceMutationResult, 'replayed'>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function normalizeAmount(value: MoneyInput, allowNegative: boolean): string {
  let amount: Decimal;
  try {
    amount = toDecimal(value);
  } catch {
    throw new LedgerError('invalid_amount');
  }
  if (!amount.isFinite() || amount.isZero() || (!allowNegative && amount.isNegative())) {
    throw new LedgerError('invalid_amount');
  }
  return toStorage(amount);
}

async function runEffect(effect: (() => Promise<void>) | undefined): Promise<void> {
  if (!effect) return;
  try {
    await effect();
  } catch {
    // PostgreSQL 已提交；临时副作用失败不能改变资金结果。
  }
}

/** 「单有效订阅」唯一部分索引的并发兜底：冲突事务以业务错误暴露，而非裸 23505。
 *  个人/组织分开的两个部分唯一索引：个人=one_personal、组织=one_org。
 *  drizzle 会把驱动错误包在 cause 链里，需逐层解包探测。 */
function isOneActiveSubscriptionViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if ((current as { code?: string }).code === '23505') {
      const constraint = (current as { constraint?: string }).constraint;
      if (
        constraint === 'user_subscriptions_one_active_uq' ||
        constraint === 'user_subscriptions_one_org_uq'
      ) {
        return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 订阅类事务统一收口：唯一索引冲突 → already_subscribed（事务整体回滚，幂等键随事务回退可安全重试） */
async function runSubscriptionTx<T>(tx: Promise<T>): Promise<T> {
  try {
    return await tx;
  } catch (error) {
    if (isOneActiveSubscriptionViolation(error)) {
      throw new LedgerError('already_subscribed');
    }
    throw error;
  }
}

export function createLedger({ db, effects, clock = () => new Date() }: LedgerDeps): Ledger {
  async function mutateBalance(input: {
    kind: 'admin.adjust' | 'admin.gift';
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult> {
    const amount = normalizeAmount(input.amount, input.kind === 'admin.adjust');
    const fp = fingerprint({
      kind: input.kind,
      userId: input.userId,
      amount,
      adminId: input.adminId,
      remark: input.remark ?? null,
    });

    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(fundOperations)
        .values({ operationId: input.operationId, kind: input.kind, fingerprint: fp })
        .onConflictDoNothing({ target: fundOperations.operationId })
        .returning({ operationId: fundOperations.operationId });

      if (inserted.length === 0) {
        const existing = await tx.query.fundOperations.findFirst({
          where: eq(fundOperations.operationId, input.operationId),
        });
        if (!existing || existing.kind !== input.kind || existing.fingerprint !== fp) {
          throw new LedgerError('idempotency_conflict');
        }
        if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
        return { ...(existing.result as StoredMutation), replayed: true };
      }

      const amountDec = new Decimal(amount);
      // 信用模型：扣减（负向调账）只要求 balance 不跌破 -credit_limit（由 DB 约束兜底），
      // 不再要求覆盖在途敞口（reserved_balance 是熔断敞口，非冻结）。
      const where = amountDec.isNegative()
        ? sql`${users.id} = ${input.userId}
              and ${users.balance} + ${amount}::numeric >= -${users.creditLimit}`
        : eq(users.id, input.userId);
      const updated = await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
        .where(where)
        .returning({ balance: users.balance });
      if (updated.length === 0) {
        const user = await tx.query.users.findFirst({
          where: eq(users.id, input.userId),
          columns: { id: true },
        });
        throw new LedgerError(user ? 'insufficient_balance' : 'user_not_found');
      }

      const balanceAfter = updated[0]!.balance;
      const balanceBefore = toStorage(new Decimal(balanceAfter).minus(amountDec));
      const [entry] = await tx
        .insert(transactions)
        .values({
          userId: input.userId,
          type: input.kind === 'admin.gift' ? 'gift' : 'manual',
          amount,
          balanceBefore,
          balanceAfter,
          refType: input.kind === 'admin.gift' ? 'admin_gift' : 'admin_adjust',
          refId: input.operationId,
          remark: input.remark ?? null,
          createdBy: input.adminId,
        })
        .returning({ id: transactions.id });
      const stored: StoredMutation = {
        transactionId: entry!.id,
        amount,
        balanceBefore,
        balanceAfter,
      };
      await tx
        .update(fundOperations)
        .set({ transactionId: entry!.id, result: stored })
        .where(eq(fundOperations.operationId, input.operationId));
      return { ...stored, replayed: false };
    });

    if (!result.replayed) {
      await runEffect(
        () =>
          effects?.balanceChanged?.({ userId: input.userId, balanceAfter: result.balanceAfter }) ??
          Promise.resolve(),
      );
      await runEffect(
        () =>
          effects?.audit?.({
            adminId: input.adminId,
            action: input.kind === 'admin.gift' ? 'user.gift' : 'user.adjust',
            targetType: 'user',
            targetId: input.userId,
            detail: {
              amount: result.amount,
              before: result.balanceBefore,
              after: result.balanceAfter,
            },
          }) ?? Promise.resolve(),
      );
    }
    return result;
  }

  async function applySubscription(input: {
    kind: 'subscription.purchase' | 'subscription.renew';
    operationId: string;
    userId: number | null;
    planId: number | null;
    subscriptionId: number | null;
    quantity: number | null;
    orgId: number | null;
    /** 团队套餐购买时在事务内复用/创建组织（T3：org 与订阅同生共死，重放不刷行） */
    ensureOrg?: boolean;
    adminId: number | null;
  }): Promise<SubscribeResult> {
    const fp = fingerprint({
      kind: input.kind,
      userId: input.userId,
      planId: input.planId,
      subscriptionId: input.subscriptionId,
      quantity: input.quantity,
      orgId: input.orgId,
    });
    const result = await runSubscriptionTx(
      db.transaction(async (tx): Promise<SubscribeResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId: input.operationId, kind: input.kind, fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, input.operationId),
          });
          if (!existing || existing.kind !== input.kind || existing.fingerprint !== fp) {
            throw new LedgerError('idempotency_conflict');
          }
          if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return { ...(existing.result as Omit<SubscribeResult, 'replayed'>), replayed: true };
        }

        const now = clock();
        let userId = input.userId;
        let planId = input.planId;
        let quantity = input.quantity ?? 1;
        let startAt = now;
        // 续费时从旧订阅继承的组织归属（R3-1）；购买时以 input.orgId 为准
        let renewOrgId: number | null = null;

        if (input.kind === 'subscription.renew') {
          // 只允许对有效订阅续费（R3-3：status=0 过滤，已取消/已被替换的订阅不得复活）；
          // orgId 随订阅继承（R3-1：组织订阅续费不得降级为个人订阅）。
          const sub = await tx.query.userSubscriptions.findFirst({
            where: and(
              eq(userSubscriptions.id, input.subscriptionId ?? 0),
              eq(userSubscriptions.status, 0),
            ),
            columns: { userId: true, planId: true, endAt: true, quantity: true, orgId: true },
          });
          if (!sub) throw new LedgerError('no_subscription');
          // 用户自助续费：校验订阅归属（管理员不传 userId，不限归属）
          if (input.userId != null && sub.userId !== input.userId) {
            throw new LedgerError('no_subscription');
          }
          userId = sub.userId;
          planId = sub.planId;
          quantity = sub.quantity; // 续费沿用原席位
          renewOrgId = sub.orgId;
          // 顺延：到期后续费从 now 起，未到期续费从旧 end 起
          startAt = sub.endAt > now ? sub.endAt : now;
          // 旧订阅转到期；0 行命中 = 状态已被并发改变（如取消），不得继续
          const expired = await tx
            .update(userSubscriptions)
            .set({ status: 1 })
            .where(
              and(
                eq(userSubscriptions.id, input.subscriptionId ?? 0),
                eq(userSubscriptions.status, 0),
              ),
            )
            .returning({ id: userSubscriptions.id });
          if (expired.length === 0) throw new LedgerError('no_subscription');
        } else {
          if (!Number.isInteger(quantity) || quantity < 1) {
            throw new LedgerError('invalid_quantity');
          }
          // C4：惰性翻转「已自然到期但 status 仍为 0」的订阅行（个人与组织皆翻）。
          // 覆盖范围对齐 user_subscriptions_one_active_uq（per-user 全维）——不翻则
          // 新购买 insert 撞唯一索引 → already_subscribed，用户被死锁。过期行翻 1
          // 不影响续费：renew 只认 status=0，而「翻过期行」必然伴随同事务内插入
          // 新活跃订阅（此时续费本就该走新订阅）。
          await tx
            .update(userSubscriptions)
            .set({ status: 1 })
            .where(
              and(
                eq(userSubscriptions.userId, userId!),
                eq(userSubscriptions.status, 0),
                lte(userSubscriptions.endAt, now),
              ),
            );
          const active = await tx.query.userSubscriptions.findFirst({
            where: and(
              eq(userSubscriptions.userId, userId!),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, now),
            ),
            columns: { id: true },
          });
          if (active) throw new LedgerError('already_subscribed');
        }

        const plan = await tx.query.plans.findFirst({
          where: eq(plans.id, planId ?? 0),
          columns: {
            name: true,
            price: true,
            periodDays: true,
            quotaAmount: true,
            status: true,
            kind: true,
            allowSeats: true,
          },
        });
        if (!plan) throw new LedgerError('plan_not_found');
        if (plan.status !== 0) throw new LedgerError('plan_disabled');
        // 自助购买闸门：上架套餐必须正价——price<=0 的「套餐」走余额闸门恒真，
        // 等于免费额度印刷机（R2：e2e 实测 ¥0 白得 ¥10 亿额度）。零价套餐只允许
        // 存在于非上架状态（管理端创建/更新已强制 price>0，此处为资金侧最后防线）。
        if (toDecimal(plan.price).lte(0)) throw new LedgerError('plan_not_purchasable');
        if (plan.kind !== 'subscription') throw new LedgerError('not_a_pack');
        if (quantity > 1 && !plan.allowSeats) throw new LedgerError('seats_not_allowed');
        if (plan.allowSeats) {
          const userRow = await tx.query.users.findFirst({
            where: eq(users.id, userId!),
            columns: { isEnterprise: true },
          });
          if (!userRow) throw new LedgerError('user_not_found');
          if (!userRow.isEnterprise) throw new LedgerError('enterprise_required');
        }
        // T3：团队套餐的组织在账本事务内创建（与订阅同生共死）——路由层预建会在
        // 购买失败时留下孤儿 org，且重放时新 org 改变 fingerprint → 409（幂等性失效）。
        // 幂等重放在 fund_operations 提前返回（携带首次 orgId），失败回滚则 org 一并消失。
        let orgId = input.orgId;
        if (input.ensureOrg && orgId == null && userId != null && plan.allowSeats) {
          const [org] = await tx
            .insert(organizations)
            .values({ name: `组织-${randomUUID().slice(0, 6)}`, ownerUserId: userId })
            .returning({ id: organizations.id });
          orgId = org!.id;
          await tx.insert(orgMembers).values({
            orgId: org!.id,
            userId,
            role: 'owner',
            status: 0,
          });
        }

        const endAt = new Date(startAt.getTime() + Number(plan.periodDays) * 86_400_000);
        // 总价 = 档价 × 席位；总额度 = 档额度 × 席位（快照）
        const totalPrice = toDecimal(plan.price).times(quantity);
        const totalQuota = toDecimal(plan.quotaAmount).times(quantity);
        const price = toStorage(totalPrice);
        // 不允许透支余额买套餐（防套现）：可用余额 balance - reserved >= price
        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} - ${price}::numeric`, updatedAt: now })
          .where(
            sql`${users.id} = ${userId}
                and ${users.balance} - ${users.reservedBalance} >= ${price}::numeric`,
          )
          .returning({ balance: users.balance });
        if (updated.length === 0) {
          const u = await tx.query.users.findFirst({
            where: eq(users.id, userId!),
            columns: { id: true },
          });
          throw new LedgerError(u ? 'insufficient_balance' : 'user_not_found');
        }
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(toDecimal(balanceAfter).plus(totalPrice));

        const [sub] = await tx
          .insert(userSubscriptions)
          .values({
            userId: userId!,
            planId: planId!,
            startAt,
            endAt,
            quotaAmount: toStorage(totalQuota),
            usedAmount: '0',
            reservedAmount: '0',
            quantity,
            price,
            // 续费继承旧订阅的组织归属（R3-1）；购买用事务内复用/创建的 orgId（T3）
            orgId: input.kind === 'subscription.renew' ? renewOrgId : orgId,
            status: 0,
          })
          .returning({ id: userSubscriptions.id });

        // 续费：把绑定到旧订阅的凭证改绑到新订阅（续费不打断现有 key/app）。
        if (input.kind === 'subscription.renew' && input.subscriptionId != null) {
          await tx
            .update(apiKeys)
            .set({ subscriptionId: sub!.id })
            .where(eq(apiKeys.subscriptionId, input.subscriptionId));
          await tx
            .update(apps)
            .set({ subscriptionId: sub!.id })
            .where(eq(apps.subscriptionId, input.subscriptionId));
        }

        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: userId!,
            type: 'subscribe',
            amount: toStorage(totalPrice.negated()),
            balanceBefore,
            balanceAfter,
            refType: 'subscription',
            refId: String(sub!.id),
            remark: `购买套餐「${plan.name}」×${quantity}`,
            createdBy: input.adminId,
          })
          .returning({ id: transactions.id });

        const stored: Omit<SubscribeResult, 'replayed'> = {
          userId: userId!,
          subscriptionId: sub!.id,
          orgId: input.kind === 'subscription.renew' ? renewOrgId : orgId,
          planId: planId!,
          planName: plan.name,
          quantity,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          quotaAmount: toStorage(totalQuota),
          price,
          balanceBefore,
          balanceAfter,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: stored })
          .where(eq(fundOperations.operationId, input.operationId));
        return { ...stored, replayed: false };
      }),
    );

    if (!result.replayed) {
      await runEffect(
        () =>
          effects?.balanceChanged?.({
            userId: result.userId,
            balanceAfter: result.balanceAfter,
          }) ?? Promise.resolve(),
      );
      await runEffect(
        () =>
          effects?.audit?.({
            adminId: input.adminId,
            action: input.kind,
            targetType: 'subscription',
            targetId: result.subscriptionId,
            detail: { planId: result.planId, price: result.price },
          }) ?? Promise.resolve(),
      );
    }
    return result;
  }

  return {
    async getBalance(userId) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { balance: true },
      });
      return user?.balance ?? '0';
    },

    adminGift(input) {
      return mutateBalance({ ...input, kind: 'admin.gift' });
    },

    adminAdjust(input) {
      return mutateBalance({ ...input, kind: 'admin.adjust' });
    },

    async grantSignupGift(input) {
      const amount = normalizeAmount(input.amount, false);
      const operationId = `signup-gift:${input.userId}`;
      // 资格是一次性的自然键；配置金额日后变化时，已赠送用户仍应重放首次结果。
      const fp = fingerprint({ kind: 'signup.gift', userId: input.userId });
      const result = await db.transaction(async (tx): Promise<SignupGiftResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'signup.gift', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp)
            throw new LedgerError('idempotency_conflict');
          if (existing.result && (existing.result as { granted?: boolean }).granted) {
            const stored = existing.result as Extract<SignupGiftResult, { granted: true }>;
            return { ...stored, replayed: true };
          }
          return { granted: false, reason: 'already_granted' };
        }

        const [history] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(eq(transactions.userId, input.userId));
        if (Number(history?.count ?? 0) > 0) {
          const skipped = { granted: false as const, reason: 'not_eligible' as const };
          await tx
            .update(fundOperations)
            .set({ result: skipped })
            .where(eq(fundOperations.operationId, operationId));
          return skipped;
        }

        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
          .where(sql`${users.id} = ${input.userId} and ${users.balance} = 0`)
          .returning({ balance: users.balance });
        if (updated.length === 0) {
          const skipped = { granted: false as const, reason: 'not_eligible' as const };
          await tx
            .update(fundOperations)
            .set({ result: skipped })
            .where(eq(fundOperations.operationId, operationId));
          return skipped;
        }
        const balanceAfter = updated[0]!.balance;
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'gift',
            amount,
            balanceBefore: '0',
            balanceAfter,
            refType: 'signup_gift',
            refId: operationId,
            remark: `新用户赠送 ${amount}`,
          })
          .returning({ id: transactions.id });
        const applied = {
          granted: true as const,
          transactionId: entry!.id,
          amount,
          balanceBefore: '0',
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.granted && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({
              userId: input.userId,
              balanceAfter: result.balanceAfter,
            }) ?? Promise.resolve(),
        );
        await runEffect(
          () =>
            effects?.audit?.({
              adminId: null,
              actor: 'system',
              action: 'user.signup_gift',
              targetType: 'user',
              targetId: input.userId,
              detail: { amount: result.amount },
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async redeemCode(input) {
      const codeHash = sha256(input.code);
      const operationId = `redeem:${codeHash}:${input.userId}`;
      const fp = fingerprint({ kind: 'redeem', userId: input.userId, codeHash });
      const result = await db.transaction(async (tx): Promise<RedeemResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'redeem', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp)
            throw new LedgerError('idempotency_conflict');
          if (!existing.result)
            throw new LedgerError('idempotency_conflict', 'operation incomplete');
          const stored = existing.result as RedeemResult;
          return stored.ok ? { ...stored, replayed: true } : stored;
        }

        const claimed = await tx
          .update(redeemCodes)
          .set({ status: 1, usedBy: input.userId, usedAt: clock() })
          .where(
            and(
              eq(redeemCodes.codeHash, codeHash),
              eq(redeemCodes.status, 0),
              // OR 必须整体加括号：and() 不给裸 SQL 片段加括号，SQL 里 AND 优先级
              // 高于 OR，缺括号会把 WHERE 变成「hash 匹配 OR 任意未过期码」——
              // 任意乱码都能消费一张随机有效码并按其面值入账（资金级缺陷）。
              sql`(${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > ${clock()})`,
            ),
          )
          .returning({ id: redeemCodes.id, batchId: redeemCodes.batchId });
        if (claimed.length === 0) {
          const row = await tx.query.redeemCodes.findFirst({
            where: eq(redeemCodes.codeHash, codeHash),
          });
          const reason: Extract<RedeemResult, { ok: false }>['reason'] = !row
            ? 'invalid_code'
            : row.status === 1
              ? 'code_already_used'
              : row.status === 2
                ? 'code_revoked'
                : 'code_expired';
          const rejected = { ok: false as const, reason };
          await tx
            .update(fundOperations)
            .set({ result: rejected })
            .where(eq(fundOperations.operationId, operationId));
          return rejected;
        }
        const code = claimed[0]!;
        const [batch] = await tx
          .update(redeemBatches)
          .set({ usedCount: sql`${redeemBatches.usedCount} + 1` })
          .where(eq(redeemBatches.id, code.batchId))
          .returning({ amount: redeemBatches.amount });
        if (!batch) throw new Error(`batch_not_found:${code.batchId}`);
        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${batch.amount}::numeric`, updatedAt: clock() })
          .where(eq(users.id, input.userId))
          .returning({ balance: users.balance });
        if (updated.length === 0) throw new LedgerError('user_not_found');
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(new Decimal(balanceAfter).minus(batch.amount));
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'redeem',
            amount: batch.amount,
            balanceBefore,
            balanceAfter,
            refType: 'redeem_codes',
            refId: String(code.id),
            remark: `充值码兑换 +${batch.amount}`,
          })
          .returning({ id: transactions.id });
        const applied = {
          ok: true as const,
          codeId: code.id,
          transactionId: entry!.id,
          amount: batch.amount,
          balanceBefore,
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.ok && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({
              userId: input.userId,
              balanceAfter: result.balanceAfter,
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async paymentCredit(input) {
      const operationId = `payment-credit:${input.provider}:${input.providerOrderId}`;
      const fp = fingerprint({
        kind: 'payment.credit',
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        userId: input.userId,
        creditAmount: String(input.creditAmount),
      });
      const result = await db.transaction(async (tx): Promise<PaymentCreditResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'payment.credit', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp) throw new LedgerError('idempotency_conflict');
          if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return { ...(existing.result as PaymentCreditResult), replayed: true };
        }

        // 订单状态机：created(0) → credited(2)；重复回调（已 credited/settled 外状态）幂等拒绝
        const credited = await tx
          .update(paymentOrders)
          .set({ status: 2, updatedAt: clock(), creditedAt: clock(), creditedOperationId: operationId })
          .where(
            and(
              eq(paymentOrders.id, input.paymentOrderId),
              // 合法迁移：0 created → 2 credited（回调重复到达时 0 行 → 走重放/拒绝）
              eq(paymentOrders.status, 0),
              eq(paymentOrders.userId, input.userId),
            ),
          )
          .returning({ id: paymentOrders.id });
        if (credited.length === 0) {
          const row = await tx.query.paymentOrders.findFirst({
            where: eq(paymentOrders.id, input.paymentOrderId),
          });
          const rejected: PaymentCreditResult = {
            ok: false,
            replayed: false,
            ...(row?.status === 2 ? { transactionId: undefined } : {}),
          };
          await tx
            .update(fundOperations)
            .set({ result: rejected })
            .where(eq(fundOperations.operationId, operationId));
          return rejected;
        }

        const amount = toStorage(toDecimal(input.creditAmount));
        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
          .where(eq(users.id, input.userId))
          .returning({ balance: users.balance });
        if (updated.length === 0) throw new LedgerError('user_not_found');
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(new Decimal(balanceAfter).minus(amount));
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'payment',
            amount,
            balanceBefore,
            balanceAfter,
            refType: 'payment_orders',
            refId: String(input.paymentOrderId),
            remark: `在线支付入账（${input.provider}）+${amount}`,
          })
          .returning({ id: transactions.id });
        const applied: PaymentCreditResult = {
          ok: true,
          transactionId: entry!.id,
          amount,
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.ok && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({ userId: input.userId, balanceAfter: result.balanceAfter }) ??
            Promise.resolve(),
        );
      }
      return result;
    },

    async paymentRefund(input) {
      const operationId = `payment-refund:${input.provider}:${input.providerOrderId}`;
      const fp = fingerprint({
        kind: 'payment.refund',
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        userId: input.userId,
        amount: String(input.amount),
      });
      const result = await db.transaction(async (tx): Promise<PaymentRefundResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'payment.refund', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp) throw new LedgerError('idempotency_conflict');
          if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return { ...(existing.result as PaymentRefundResult), replayed: true };
        }

        // 订单状态机：credited(2) → refunded(3)；扣减余额受信用地板守卫
        const updatedOrder = await tx
          .update(paymentOrders)
          .set({ status: 3, updatedAt: clock() })
          .where(
            and(
              eq(paymentOrders.id, input.paymentOrderId),
              eq(paymentOrders.status, 2),
              eq(paymentOrders.userId, input.userId),
            ),
          )
          .returning({ id: paymentOrders.id });
        if (updatedOrder.length === 0) {
          const rejected: PaymentRefundResult = { ok: false, replayed: false };
          await tx
            .update(fundOperations)
            .set({ result: rejected })
            .where(eq(fundOperations.operationId, operationId));
          return rejected;
        }

        const amount = toStorage(toDecimal(input.amount));
        const deducted = await tx
          .update(users)
          .set({ balance: sql`${users.balance} - ${amount}::numeric`, updatedAt: clock() })
          .where(
            sql`${users.id} = ${input.userId} and ${users.balance} - ${amount}::numeric >= -${users.creditLimit}::numeric`,
          )
          .returning({ balance: users.balance });
        if (deducted.length === 0) throw new LedgerError('insufficient_balance');
        const balanceAfter = deducted[0]!.balance;
        const balanceBefore = toStorage(new Decimal(balanceAfter).plus(amount));
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'refund',
            amount: `-${amount}`,
            balanceBefore,
            balanceAfter,
            refType: 'payment_refunds',
            refId: input.providerOrderId,
            remark: `在线支付退款（${input.provider}）-${amount}`,
          })
          .returning({ id: transactions.id });
        const applied: PaymentRefundResult = {
          ok: true,
          transactionId: entry!.id,
          amount,
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.ok && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({ userId: input.userId, balanceAfter: result.balanceAfter }) ??
            Promise.resolve(),
        );
      }
      return result;
    },

    async grantPromotionalCredit(input) {
      const fp = fingerprint({
        kind: `promo.${input.kind}`,
        userId: input.userId,
        amount: String(input.amount),
        refId: input.refId,
      });
      return db.transaction(async (tx): Promise<BalanceMutationResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId: input.operationId, kind: `promo.${input.kind}`, fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, input.operationId),
          });
          if (!existing || existing.fingerprint !== fp) throw new LedgerError('idempotency_conflict');
          if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return existing.result as BalanceMutationResult;
        }

        const amount = toStorage(toDecimal(input.amount));
        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
          .where(eq(users.id, input.userId))
          .returning({ balance: users.balance });
        if (updated.length === 0) throw new LedgerError('user_not_found');
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(new Decimal(balanceAfter).minus(amount));
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: input.kind === 'referral_commission' ? 'commission' : 'gift',
            amount,
            balanceBefore,
            balanceAfter,
            refType: input.kind === 'referral_commission' ? 'referral_commission' : 'referral_signup',
            refId: input.refId,
            remark: input.remark ?? `邀请${input.kind === 'referral_commission' ? '返佣' : '奖励'} +${amount}`,
          })
          .returning({ id: transactions.id });
        const result: BalanceMutationResult = {
          transactionId: entry!.id,
          amount,
          balanceBefore,
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result })
          .where(eq(fundOperations.operationId, input.operationId));
        return result;
      });
    },

    subscribePlan(input) {
      return applySubscription({
        kind: 'subscription.purchase',
        operationId: input.operationId,
        userId: input.userId,
        planId: input.planId,
        subscriptionId: null,
        quantity: input.quantity ?? 1,
        orgId: input.orgId ?? null,
        ensureOrg: input.ensureOrg ?? false,
        adminId: input.adminId ?? null,
      });
    },

    renewSubscription(input) {
      return applySubscription({
        kind: 'subscription.renew',
        operationId: input.operationId,
        userId: input.userId ?? null,
        planId: null,
        subscriptionId: input.subscriptionId,
        quantity: null, // 沿用原席位
        orgId: null,
        adminId: input.adminId ?? null,
      });
    },

    async changeSubscription(input) {
      // 指纹含发起者（T2 修复）：幂等 receipt 绑定 actor——跨用户用相同键重放
      // 必须是冲突（409），而不是把别人的余额快照（balanceBefore/After）回给攻击者。
      const fp = fingerprint({
        kind: 'subscription.change',
        userId: input.userId ?? null,
        adminId: input.adminId ?? null,
        subscriptionId: input.subscriptionId,
        targetPlanId: input.targetPlanId,
        quantity: input.quantity,
      });
      const result = await runSubscriptionTx(
        db.transaction(async (tx): Promise<SubscribeResult> => {
          const inserted = await tx
            .insert(fundOperations)
            .values({ operationId: input.operationId, kind: 'subscription.change', fingerprint: fp })
            .onConflictDoNothing({ target: fundOperations.operationId })
            .returning({ operationId: fundOperations.operationId });
          if (inserted.length === 0) {
            const existing = await tx.query.fundOperations.findFirst({
              where: eq(fundOperations.operationId, input.operationId),
            });
            if (!existing || existing.kind !== 'subscription.change' || existing.fingerprint !== fp) {
              throw new LedgerError('idempotency_conflict');
            }
            if (!existing.result)
              throw new LedgerError('idempotency_conflict', 'operation incomplete');
            return { ...(existing.result as Omit<SubscribeResult, 'replayed'>), replayed: true };
          }

          if (!Number.isInteger(input.quantity) || input.quantity < 1) {
            throw new LedgerError('invalid_quantity');
          }
          const now = clock();
          // F2：折算价必须基于「拿到行锁后的新鲜快照」。无锁读会和并发结算/释放
          // 竞态（used+=x / reserved-=y 在读与翻转之间提交）→ 剩余价值被低估 →
          // 升级补差价多收。FOR UPDATE 与结算/释放的行写互斥，读到提交后状态。
          const currentRows = await tx
            .select({
              userId: userSubscriptions.userId,
              planId: userSubscriptions.planId,
              orgId: userSubscriptions.orgId,
              quotaAmount: userSubscriptions.quotaAmount,
              usedAmount: userSubscriptions.usedAmount,
              reservedAmount: userSubscriptions.reservedAmount,
              quantity: userSubscriptions.quantity,
              price: userSubscriptions.price,
            })
            .from(userSubscriptions)
            .where(
              and(
                eq(userSubscriptions.id, input.subscriptionId),
                eq(userSubscriptions.status, 0),
                gt(userSubscriptions.endAt, now),
              ),
            )
            .for('update');
          const current = currentRows[0];
          if (!current) throw new LedgerError('no_subscription');
          if (input.userId != null && current.userId !== input.userId) {
            throw new LedgerError('no_subscription');
          }
          // plan 元数据（层级/名称）不受订阅行竞态影响，单独无锁读
          const currentPlan = await tx.query.plans.findFirst({
            where: eq(plans.id, current.planId),
            columns: { sortOrder: true, name: true },
          });

          const target = await tx.query.plans.findFirst({
            where: eq(plans.id, input.targetPlanId),
            columns: {
              name: true,
              price: true,
              periodDays: true,
              quotaAmount: true,
              status: true,
              kind: true,
              sortOrder: true,
              allowSeats: true,
            },
          });
          if (!target) throw new LedgerError('plan_not_found');
          if (target.status !== 0) throw new LedgerError('plan_disabled');
          if (toDecimal(target.price).lte(0)) throw new LedgerError('plan_not_purchasable');
          if (target.kind !== 'subscription') throw new LedgerError('not_a_pack');

          // 只能升不能降：sort_order 不降、席位不缩容，且至少一项变化。（先判层级，再判席位能力）
          const curSort = currentPlan?.sortOrder ?? 0;
          const targetSort = target.sortOrder ?? 0;
          if (targetSort < curSort || input.quantity < current.quantity) {
            throw new LedgerError('downgrade_not_allowed');
          }
          if (targetSort === curSort && input.quantity === current.quantity) {
            throw new LedgerError('already_subscribed');
          }
          if (input.quantity > 1 && !target.allowSeats) throw new LedgerError('seats_not_allowed');
          if (target.allowSeats) {
            const userRow = await tx.query.users.findFirst({
              where: eq(users.id, current.userId),
              columns: { isEnterprise: true },
            });
            if (!userRow) throw new LedgerError('user_not_found');
            if (!userRow.isEnterprise) throw new LedgerError('enterprise_required');
          }

          // 剩余额度 = 总额度 - 已用 - 在途；剩余价值 = 购买总价 × 剩余额度/总额度
          const remainingQuota = toDecimal(current.quotaAmount)
            .minus(toDecimal(current.usedAmount))
            .minus(toDecimal(current.reservedAmount));
          const remainingValue =
            toDecimal(current.quotaAmount).gt(0)
              ? toDecimal(current.price).times(remainingQuota).div(current.quotaAmount)
              : new Decimal(0);
          const newTotalPrice = toDecimal(target.price).times(input.quantity);
          // 补差价 = max(0, 新总价 - 剩余价值)；<=0 免费升级
          const diff = newTotalPrice.minus(remainingValue).gt(0)
            ? newTotalPrice.minus(remainingValue)
            : new Decimal(0);

          // 旧订阅转到期（保留 used/reserved，供在途请求结算）；
          // 0 行命中 = 状态已被并发改变（如取消），继续按剩余价值抵扣等于给已作废额度退钱 → 拒绝
          const expired = await tx
            .update(userSubscriptions)
            .set({ status: 1 })
            .where(and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)))
            .returning({ id: userSubscriptions.id });
          if (expired.length === 0) throw new LedgerError('no_subscription');

          // 流水的余额快照必须是用户真实余额：免费升级（diff=0）也要读库，绝不能用订阅价格顶替。
          let balanceAfter: string;
          let balanceBefore: string;
          if (diff.gt(0)) {
            const updated = await tx
              .update(users)
              .set({ balance: sql`${users.balance} - ${diff.toString()}::numeric`, updatedAt: now })
              .where(
                sql`${users.id} = ${current.userId}
                    and ${users.balance} - ${users.reservedBalance} >= ${diff.toString()}::numeric`,
              )
              .returning({ balance: users.balance });
            if (updated.length === 0) {
              const u = await tx.query.users.findFirst({
                where: eq(users.id, current.userId),
                columns: { id: true },
              });
              throw new LedgerError(u ? 'insufficient_balance' : 'user_not_found');
            }
            balanceAfter = updated[0]!.balance;
            balanceBefore = toStorage(toDecimal(balanceAfter).plus(diff));
          } else {
            const u = await tx.query.users.findFirst({
              where: eq(users.id, current.userId),
              columns: { balance: true },
            });
            if (!u) throw new LedgerError('user_not_found');
            balanceAfter = u.balance;
            balanceBefore = u.balance;
          }

          const endAt = new Date(now.getTime() + Number(target.periodDays) * 86_400_000);
          const totalQuota = toDecimal(target.quotaAmount).times(input.quantity);
          const [sub] = await tx
            .insert(userSubscriptions)
            .values({
              userId: current.userId,
              planId: input.targetPlanId,
              startAt: now,
              endAt,
              quotaAmount: toStorage(totalQuota),
              usedAmount: '0',
              reservedAmount: '0',
              quantity: input.quantity,
              price: toStorage(newTotalPrice),
              // 组织归属随订阅继承（R3-2b：升档不得把组织订阅变个人订阅）
              orgId: current.orgId,
              status: 0,
            })
            .returning({ id: userSubscriptions.id });

          // 升档同样要把绑定旧订阅的凭证改绑到新订阅（R3-2：与续费同语义——
          // 用户付了差价后，既有 Key/App 不应全员 402 subscription_required）。
          await tx
            .update(apiKeys)
            .set({ subscriptionId: sub!.id })
            .where(eq(apiKeys.subscriptionId, input.subscriptionId));
          await tx
            .update(apps)
            .set({ subscriptionId: sub!.id })
            .where(eq(apps.subscriptionId, input.subscriptionId));

          const [entry] = await tx
            .insert(transactions)
            .values({
              userId: current.userId,
              type: 'subscribe',
              amount: toStorage(diff.negated()),
              balanceBefore,
              balanceAfter,
              refType: 'subscription',
              refId: String(sub!.id),
              remark: `变更套餐「${currentPlan?.name ?? `#${current.planId}`}」→「${target.name}」×${input.quantity} 补差价 ${toStorage(diff)}`,
              createdBy: input.adminId,
            })
            .returning({ id: transactions.id });

          const stored: Omit<SubscribeResult, 'replayed'> = {
            userId: current.userId,
            subscriptionId: sub!.id,
            orgId: current.orgId,
            planId: input.targetPlanId,
            planName: target.name,
            quantity: input.quantity,
            startAt: now.toISOString(),
            endAt: endAt.toISOString(),
            quotaAmount: toStorage(totalQuota),
            price: toStorage(newTotalPrice),
            balanceBefore,
            balanceAfter,
          };
          await tx
            .update(fundOperations)
            .set({ transactionId: entry!.id, result: stored })
            .where(eq(fundOperations.operationId, input.operationId));
          return { ...stored, replayed: false };
        }),
      );

      if (!result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({ userId: result.userId, balanceAfter: result.balanceAfter }) ??
            Promise.resolve(),
        );
        await runEffect(
          () =>
            effects?.audit?.({
              adminId: input.adminId,
              action: 'subscription.change',
              targetType: 'subscription',
              targetId: result.subscriptionId,
              detail: { planId: result.planId, quantity: result.quantity, price: result.price },
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async grantPack(input) {
      const fp = fingerprint({ kind: 'pack.grant', userId: input.userId, packId: input.packId });
      const result = await db.transaction(async (tx): Promise<SubscribeResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId: input.operationId, kind: 'pack.grant', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, input.operationId),
          });
          if (!existing || existing.kind !== 'pack.grant' || existing.fingerprint !== fp) {
            throw new LedgerError('idempotency_conflict');
          }
          if (!existing.result)
            throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return { ...(existing.result as Omit<SubscribeResult, 'replayed'>), replayed: true };
        }

        const pack = await tx.query.plans.findFirst({
          where: eq(plans.id, input.packId),
          columns: { name: true, price: true, quotaAmount: true, status: true, kind: true },
        });
        if (!pack) throw new LedgerError('plan_not_found');
        if (pack.status !== 0) throw new LedgerError('plan_disabled');
        if (pack.kind !== 'pack') throw new LedgerError('not_a_pack');

        const now = clock();
        const price = toDecimal(pack.price);
        const quota = toDecimal(pack.quotaAmount);

        // 加油包加的是「订阅额度」：必须有有效订阅；扣售价，订阅额度 += 到账额度。
        // P1-3：选订阅行 FOR UPDATE——无锁读会和并发取消/变更竞态（读到 status=0
        // 后该行被置 1），随后额度加到失效订阅 = 用户付了钱额度进了死行。
        // 行锁与取消/变更的行写互斥，READ COMMITTED 下等到的是提交后的最新版本。
        const subRows = await tx
          .select({ id: userSubscriptions.id })
          .from(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, input.userId),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, now),
            ),
          )
          .for('update');
        const sub = subRows[0];
        if (!sub) throw new LedgerError('no_subscription');

        const updated = await tx
          .update(users)
          .set({
            balance: sql`${users.balance} - ${toStorage(price)}::numeric`,
            updatedAt: now,
          })
          .where(
            sql`${users.id} = ${input.userId}
                and ${users.balance} - ${users.reservedBalance} >= ${toStorage(price)}::numeric`,
          )
          .returning({ balance: users.balance });
        if (updated.length === 0) {
          const u = await tx.query.users.findFirst({
            where: eq(users.id, input.userId),
            columns: { id: true },
          });
          throw new LedgerError(u ? 'insufficient_balance' : 'user_not_found');
        }
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(toDecimal(balanceAfter).plus(price));

        // P1-3：额度 UPDATE 带 status=0 守卫并校验 returning——不变量下沉 DB 语义，
        // 0 行命中说明订阅已被并发取消/替换，绝不能把额度加到失效行上。
        const subUpdated = await tx
          .update(userSubscriptions)
          .set({
            quotaAmount: sql`${userSubscriptions.quotaAmount} + ${toStorage(quota)}::numeric`,
          })
          .where(and(eq(userSubscriptions.id, sub.id), eq(userSubscriptions.status, 0)))
          .returning({ id: userSubscriptions.id });
        if (subUpdated.length === 0) throw new LedgerError('subscription_inactive');

        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'pack',
            amount: toStorage(price.negated()),
            balanceBefore,
            balanceAfter,
            refType: 'pack_grant',
            refId: String(input.packId),
            remark: `加油包「${pack.name}」到账额度 ${toStorage(quota)}（售价 ${toStorage(price)}）`,
            createdBy: input.adminId,
          })
          .returning({ id: transactions.id });

        const stored: Omit<SubscribeResult, 'replayed'> = {
          userId: input.userId,
          subscriptionId: 0,
          orgId: null,
          planId: input.packId,
          planName: pack.name,
          quantity: 1,
          startAt: now.toISOString(),
          endAt: now.toISOString(),
          quotaAmount: toStorage(quota),
          price: toStorage(price),
          balanceBefore,
          balanceAfter,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: stored })
          .where(eq(fundOperations.operationId, input.operationId));
        return { ...stored, replayed: false };
      });

      if (!result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({ userId: result.userId, balanceAfter: result.balanceAfter }) ??
            Promise.resolve(),
        );
        await runEffect(
          () =>
            effects?.audit?.({
              adminId: input.adminId,
              action: 'pack.grant',
              targetType: 'pack',
              targetId: result.planId,
              detail: { userId: result.userId, quotaAmount: result.quotaAmount, price: result.price },
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async cancelSubscription(input) {
      const fp = fingerprint({
        kind: 'subscription.cancel',
        userId: null,
        adminId: input.adminId ?? null,
        subscriptionId: input.subscriptionId,
      });
      const result = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId: input.operationId, kind: 'subscription.cancel', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, input.operationId),
          });
          if (!existing || existing.kind !== 'subscription.cancel' || existing.fingerprint !== fp) {
            throw new LedgerError('idempotency_conflict');
          }
          if (!existing.result)
            throw new LedgerError('idempotency_conflict', 'operation incomplete');
          return { ...(existing.result as { subscriptionId: number }), replayed: true };
        }
        const changed = await tx
          .update(userSubscriptions)
          .set({ status: 2 })
          .where(
            and(
              eq(userSubscriptions.id, input.subscriptionId),
              eq(userSubscriptions.status, 0),
            ),
          )
          .returning({ id: userSubscriptions.id });
        if (changed.length === 0) throw new LedgerError('no_subscription');
        const stored = { subscriptionId: changed[0]!.id };
        await tx
          .update(fundOperations)
          .set({ result: stored })
          .where(eq(fundOperations.operationId, input.operationId));
        return { ...stored, replayed: false };
      });
      if (!result.replayed) {
        await runEffect(
          () =>
            effects?.audit?.({
              adminId: input.adminId ?? null,
              action: 'subscription.cancel',
              targetType: 'subscription',
              targetId: result.subscriptionId,
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async reconcile(input = {}) {
      if (input.scope === 'user' && input.userId !== undefined) {
        return { checkedUsers: 1, discrepancies: (await reconcileUser(db, input.userId)) ? 0 : 1 };
      }
      if (input.scope === 'usage' && input.userId !== undefined) {
        return {
          checkedUsers: 1,
          discrepancies: (await reconcileUsageVsTransactions(db, input.userId)) ? 0 : 1,
        };
      }
      return reconcileAll(db, input.recentDays);
    },
  };
}
