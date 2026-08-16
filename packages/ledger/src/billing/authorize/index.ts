import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, userSubscriptions, users } from '@ai-gateway/db/schema';
import { toDecimal, toStorage } from '@ai-gateway/money';
import type { AuthorizeBillingCommand, BillingAuthorization } from '../types.js';
import { calculateRequired, fingerprint, leaseUntil } from '../quote.js';
import { BillingStateConflictError, InsufficientBalanceError, SubscriptionQuotaExhaustedError } from '../errors.js';
import { assertDailyLimitsAndResolveSource } from './limits.js';
import { gateSubscription } from './subscription-gate.js';
import { assertBalanceGate } from './balance-gate.js';

export { createAdmission } from './admission.js';
export type { Admission, AdmissionGate } from './admission.js';

/**
 * 授权预扣编排（对外唯一入口，billing/index.ts 消费）：
 *
 *   准入闸（admission.ts）→ 金额推导（quote.ts）→ 事务{
 *     pg_advisory_xact_lock(user)
 *     → 每日限额 + 来源解析（limits.ts）
 *     → 订阅闸（subscription-gate.ts）/ 余额闸（balance-gate.ts）
 *     → INSERT billing_requests（幂等重放：同指纹返回现状，异指纹冲突）
 *     → 免费模型 fast-path（0 元不预留）
 *     → 原子预占（套餐 reserved_amount / 余额 reserved_balance，守卫内联 WHERE）
 *   }
 *
 * 资金不变量全部下沉 DB：余额/额度守卫在 UPDATE WHERE（R4 防并发超扣）；
 * SUM 类限额靠 advisory lock 串行（F4 防 READ COMMITTED 并发突破）。
 */
export async function authorize(
  db: Db,
  clock: () => Date,
  admission: import('./admission.js').Admission | undefined,
  command: AuthorizeBillingCommand,
): Promise<BillingAuthorization> {
  await admission?.assertCapacity();
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
    // F4：每日/成员限额是 SUM 口径，READ COMMITTED 下看不见并发未提交行 →
    // 并发突刺可整体突破「细水长流」上限（硬闸门余额/额度本就原子，不受影响）。
    // pg_advisory_xact_lock 按 user 串行化授权决策，锁随事务终结自动释放——
    // DB 层串行原语，不是重试补丁。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('billing.authorize.user:' || ${command.userId}::text))`,
    );
    const subscriptionId = await assertDailyLimitsAndResolveSource(tx, now, command, amount);
    const amountDec = toDecimal(amount);
    let planReservedAmount: string | null = null;
    if (subscriptionId != null) {
      planReservedAmount = await gateSubscription(
        tx,
        now,
        command.userId,
        subscriptionId,
        amountDec,
        amount,
      );
    } else {
      await assertBalanceGate(tx, command.userId, amountDec);
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
      // 幂等重放：同 requestId + 同指纹 + 同金额 → 返回现状；否则是授权冲突
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
        toDecimal(userRow.balance).plus(userRow.creditLimit).minus(userRow.reservedBalance),
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
}
