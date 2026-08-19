/**
 * billing/authorize（S5 重写）：授权预扣管线——钱包之上。
 *
 *   准入闸 → 金额推导（rating）→ 事务{
 *     pg_advisory_xact_lock(user)
 *     → 每日限额 + 来源解析（gates/daily-limit）
 *     → INSERT billing_requests（幂等重放：同指纹返回现状，异指纹冲突）
 *     → 免费模型 fast-path（0 元不预留）
 *     → 资金预占：PAYG = wallet.authorize（refType 'billing'，无 expiresAt——
 *       生命周期由 billing 显式 release/settle 管理，避免双超时系统打架）；
 *       订阅 = subscription.reserveQuota（额度非钱，不进 wallet）
 *   }
 *
 * 与旧实现（authorize/index.ts）的差异：资金守卫与预占由 wallet 内核锁内承担
 * （users.balance / reserved_balance 不再被触碰）；SUM 类限额仍靠 advisory lock
 * 串行（F4）。回执的余额口径读自 wallet（提交后一致快照）。
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, users } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { fingerprintOf } from '@ai-gateway/ledger-core';
import { calculateRequired } from '../rating/quote.js';
import { reserveQuota } from '../subscription/quota.js';
import type { DomainTx } from '../platform/operations.js';
import { BillingStateConflictError, InsufficientBalanceError } from '../platform/errors.js';
import type { AuthorizeBillingCommand, BillingAuthorization } from './types.js';
import type { Admission } from './gates/admission.js';
import { assertDailyLimitsAndResolveSource } from './gates/daily-limit.js';
import { gateSubscription } from './gates/source.js';
import { leaseUntil } from './lease.js';

/** wallet 账户摘要 → 旧回执口径（资金事实以 wallet 为准） */
export async function walletAvailability(
  wallet: Wallet,
  userId: number,
): Promise<{ settledBalance: string; reservedBalance: string; availableBalance: string }> {
  const summaries = await wallet.accounts(userId);
  const summary = summaries.find((item) => item.currency === 'CNY') ?? summaries[0];
  if (!summary) {
    return { settledBalance: '0', reservedBalance: '0', availableBalance: '0' };
  }
  return {
    settledBalance: summary.balance,
    reservedBalance: summary.inFlight,
    availableBalance: toStorage(
      toDecimal(summary.balance).plus(summary.creditLimit).minus(summary.inFlight),
    ),
  };
}

export async function authorizeBilling(
  db: Db,
  wallet: Wallet,
  clock: () => Date,
  admission: Admission | undefined,
  command: AuthorizeBillingCommand,
): Promise<BillingAuthorization> {
  await admission?.assertCapacity();
  const amount = toStorage(calculateRequired(command.quote, command.reservationLimit));
  const fp = fingerprintOf({
    requestId: command.requestId,
    userId: command.userId,
    apiKeyId: command.apiKeyId ?? null,
    stream: command.stream,
    quote: command.quote,
    amount,
  });
  const now = clock();
  const replayed = await db.transaction(async (tx): Promise<boolean> => {
    // F4：每日/成员限额是 SUM 口径，READ COMMITTED 下看不见并发未提交行——
    // advisory lock 按 user 串行化授权决策，锁随事务终结自动释放。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('billing.authorize.user:' || ${command.userId}::text))`,
    );
    const subscriptionId = await assertDailyLimitsAndResolveSource(tx, now, command, amount);
    const amountDec = toDecimal(amount);
    if (subscriptionId != null) {
      // 订阅来源闸：有效性（status=0 且未到期）→ 防御（owner/org 成员）→
      // 成员日限 a / 成员配额 b → 套餐剩余额度硬顶（拒绝语义在此，写入在下方）
      await gateSubscription(tx, now, command.userId, subscriptionId, amountDec, amount);
    }

    const inserted = await tx
      .insert(billingRequests)
      .values({
        requestId: command.requestId,
        userId: command.userId,
        apiKeyId: command.apiKeyId ?? null,
        reservedAmount: amount,
        planReservedAmount: subscriptionId != null ? amount : null,
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
      return true;
    }

    if (amountDec.isZero()) {
      // 免费模型 fast-path：不预留、不落资金动作（billing_requests 已落行供链路观测）。
      return false;
    }

    if (subscriptionId != null) {
      // 订阅来源：预占套餐额度（守卫内联；额度非钱不进 wallet）
      await reserveQuota(tx, { subscriptionId, userId: command.userId, amount });
    } else {
      // PAYG：wallet 冻结（守卫 = balance + credit_limit − in_flight ≥ amount，
      // 锁内原子；refId = requestId，无 expiresAt——生命周期由 billing 管理）
      await wallet.authorize({
        userId: command.userId,
        amount,
        refType: 'billing',
        refId: command.requestId,
        memo: `billing reserve ${command.requestId}`,
        tx: tx as unknown as Parameters<Wallet['authorize']>[0]['tx'],
      });
    }
    return false;
  });

  // 用户存在性防御 + 回执余额口径（提交后读 wallet，一致快照）
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, command.userId),
    columns: { id: true },
  });
  if (!userRow) throw new InsufficientBalanceError(command.userId, '0');
  const availability = await walletAvailability(wallet, command.userId);
  return {
    requestId: command.requestId,
    reservedAmount: amount,
    settledBalance: availability.settledBalance,
    reservedBalance: availability.reservedBalance,
    availableBalance: availability.availableBalance,
    replayed,
  };
}

/** 事务内快速判重（processor 复验路径用） */
export async function findBillingRequest(tx: DomainTx, requestId: string) {
  return tx.query.billingRequests.findFirst({
    where: eq(billingRequests.requestId, requestId),
  });
}
