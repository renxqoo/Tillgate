import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  transactions,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db/schema';
import { Decimal, calcAmount, toDecimal, toStorage } from '@ai-gateway/money';
import type { Redis } from 'ioredis';
import type { SettleClaimResult, SettlementClaim, UsageReceipt } from './types.js';

/**
 * 结算一个已持久化收据。调用方不能直接指定扣费主体或可捕获金额：
 * billing_requests 的用户、预扣和 settlement_pending 状态才是授权事实。
 */
export async function settleClaim(db: Db, claim: SettlementClaim): Promise<SettleClaimResult> {
  const data = claim.receipt;
  const calculated = calcAmount({
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    outputPrice: data.outputPrice,
    coefficient: data.coefficient,
  });
  const calculatedAmount = toStorage(calculated);

  const inputTokens = Math.max(0, data.usage.inputTokens);
  const cached = Math.min(Math.max(0, data.usage.cachedInputTokens), inputTokens);
  const uncached = inputTokens - cached;
  const base = toDecimal(data.inputPrice)
    .times(uncached)
    .plus(toDecimal(data.cacheInputPrice).times(cached))
    .plus(toDecimal(data.outputPrice).times(Math.max(0, data.usage.outputTokens)));
  const upstreamCostDec = base.div(1_000_000);
  const upstreamCost = toStorage(upstreamCostDec.lt(0) ? new Decimal(0) : upstreamCostDec);

  let outcome: SettleClaimResult['outcome'] = 'claim_lost';
  let amount = '0';
  let channelCircuitBroken = false;
  await db.transaction(async (tx) => {
    const billing = await tx.query.billingRequests.findFirst({
      where: and(
        eq(billingRequests.requestId, data.requestId),
        eq(billingRequests.status, 'processing'),
        eq(billingRequests.claimToken, claim.claimToken),
        eq(billingRequests.claimOwner, claim.ownerId),
        eq(billingRequests.revision, claim.revision),
        gt(billingRequests.claimUntil, sql`clock_timestamp()`),
      ),
      columns: {
        userId: true,
        reservedAmount: true,
        planReservedAmount: true,
        subscriptionId: true,
        channelId: true,
        channelReservedAmount: true,
      },
    });
    if (!billing) {
      const existingUsage = await tx.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, data.requestId),
        columns: { amount: true, calculatedAmount: true },
      });
      if (existingUsage) {
        amount = existingUsage.amount;
        outcome = 'already_settled';
      }
      return;
    }
    if (billing.userId !== data.userId) throw new Error('billing_receipt_user_mismatch');

    // 信用模型：不再有「calculated > 预估 → dead」的金额不变量。reserved_amount 只是并发熔断的
    // 在途敞口估算（authorize 时记），实际金额可能略超预估；结算无条件按实际金额扣费，
    // balance 可降至 -credit_limit（由 DB 约束 users_balance_credit_floor_ck 兜底，触底即 check
    // violation → processor 归为 invariant_violation → dead 人工复核/充值）。
    if (data.usage.estimated) throw new Error('billing_invariant_estimated_usage');
    amount = calculatedAmount;

    // 套餐/余额分流：plan 部分封顶在「释放后剩余额度」内，套餐额度永不为负；ε 溢出走余额。
    const planReserve = toDecimal(billing.planReservedAmount ?? '0');
    const paygReserve = toDecimal(billing.reservedAmount).minus(planReserve);
    let planCharge = new Decimal(0);
    let paygCharge = calculated;
    let billedBy: 'plan' | 'payg' | 'both' = 'payg';

    if (billing.subscriptionId != null) {
      // 释放套餐在途敞口（本请求的 plan 部分），并读回当前 used 以计算剩余。
      const subReleased = await tx
        .update(userSubscriptions)
        .set({
          reservedAmount: sql`${userSubscriptions.reservedAmount} - ${planReserve.toString()}::numeric`,
        })
        .where(
          sql`${userSubscriptions.id} = ${billing.subscriptionId}
              and ${userSubscriptions.reservedAmount} >= ${planReserve.toString()}::numeric`,
        )
        .returning({
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
        });
      if (subReleased.length === 0) throw new Error('subscription_reservation_invariant');
      const remaining = toDecimal(subReleased[0]!.quotaAmount).minus(
        toDecimal(subReleased[0]!.usedAmount),
      );
      planCharge = Decimal.min(calculated, remaining.gt(0) ? remaining : new Decimal(0));
      paygCharge = calculated.minus(planCharge);
      billedBy =
        planCharge.gt(0) && paygCharge.gt(0) ? 'both' : planCharge.gt(0) ? 'plan' : 'payg';
    }

    const inserted = await tx
      .insert(usageLogs)
      .values({
        requestId: data.requestId,
        userId: billing.userId,
        appId: data.appId,
        apiKeyId: data.apiKeyId,
        credentialType: data.credentialType,
        externalModel: data.externalModel,
        realModel: data.realModel,
        channelId: data.channelId,
        inputTokens: data.usage.inputTokens,
        cachedInputTokens: data.usage.cachedInputTokens,
        outputTokens: data.usage.outputTokens,
        inputPrice: data.inputPrice,
        outputPrice: data.outputPrice,
        cacheInputPrice: data.cacheInputPrice,
        coefficient: toDecimal(data.coefficient).toFixed(3),
        amount,
        calculatedAmount,
        upstreamCost,
        planAmount: planCharge.toString(),
        paygAmount: paygCharge.toString(),
        billedBy,
        subscriptionId: planCharge.gt(0) ? billing.subscriptionId : null,
        durationMs: data.durationMs,
        status: 0,
        stream: data.stream,
        streamAborted: data.streamAborted,
      })
      .onConflictDoNothing({ target: usageLogs.requestId })
      .returning({ id: usageLogs.id });
    if (inserted.length === 0) throw new Error('billing_invariant_usage_conflict');

    // 套餐已用额度累加（封顶：used + planCharge ≤ quota，硬闸保证不扣负）。
    if (planCharge.gt(0)) {
      const subCharged = await tx
        .update(userSubscriptions)
        .set({
          usedAmount: sql`${userSubscriptions.usedAmount} + ${planCharge.toString()}::numeric`,
        })
        .where(
          sql`${userSubscriptions.id} = ${billing.subscriptionId}
              and ${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} >= ${planCharge.toString()}::numeric`,
        )
        .returning({ id: userSubscriptions.id });
      if (subCharged.length === 0) throw new Error('subscription_quota_invariant');
    }

    // 余额只扣 payg 部分、只释放 payg 在途敞口。
    const updated = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} - ${paygCharge.toString()}::numeric`,
        reservedBalance: sql`${users.reservedBalance} - ${paygReserve.toString()}::numeric`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(users.id, billing.userId),
          sql`${users.reservedBalance} >= ${paygReserve.toString()}::numeric`,
        ),
      )
      .returning({ balance: users.balance });
    if (updated.length === 0) throw new Error('billing_user_missing');
    const balanceAfter = updated[0]!.balance;
    // reservation 本身不写资金流水；consume 流水只表达余额实扣（payg 部分）。
    const balanceBefore = toStorage(toDecimal(balanceAfter).plus(paygCharge));

    // 释放渠道在途敞口（若有：本请求在最终成功渠道上的上游成本预估）
    if (billing.channelId != null && billing.channelReservedAmount != null) {
      const channelReleased = await tx
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} - ${billing.channelReservedAmount}::numeric`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          sql`${channels.id} = ${billing.channelId}
              and ${channels.upstreamReserved} >= ${billing.channelReservedAmount}::numeric`,
        )
        .returning({ id: channels.id });
      if (channelReleased.length === 0) throw new Error('channel_reservation_invariant');
    }

    // consume 流水只表达余额实扣（payg 部分）；全额由套餐覆盖（payg=0）时不写余额流水。
    if (paygCharge.gt(0)) {
      const insertedTransaction = await tx
        .insert(transactions)
        .values({
          userId: billing.userId,
          type: 'consume',
          amount: toStorage(paygCharge.negated()),
          balanceBefore,
          balanceAfter,
          refType: 'usage_logs',
          refId: data.requestId,
          remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens)`,
        })
        .onConflictDoNothing({
          target: [transactions.refType, transactions.refId],
          where: sql`ref_type = 'usage_logs'`,
        })
        .returning({ id: transactions.id });
      if (insertedTransaction.length === 0) {
        throw new Error('billing_invariant_transaction_conflict');
      }
    }

    const finalized = await tx
      .update(billingRequests)
      .set({
        status: 'settled',
        revision: sql`${billingRequests.revision} + 1`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        settledAt: sql`clock_timestamp()`,
        nextSettlementAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, data.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claim.claimToken),
          eq(billingRequests.claimOwner, claim.ownerId),
          eq(billingRequests.revision, claim.revision),
          gt(billingRequests.claimUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ requestId: billingRequests.requestId });
    if (finalized.length === 0) throw new Error('billing_state_changed_during_settlement');
    outcome = 'settled';

    // 渠道「进货额度」= 余额模型：结算时原子扣减实际上游成本，并检查余额耗尽 → 熔断。
    if (data.channelId != null) {
      const channelDeduct = await tx
        .update(channels)
        .set({
          upstreamBudget: sql`${channels.upstreamBudget} - ${upstreamCost}::numeric`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(channels.id, data.channelId))
        .returning({
          upstreamBudget: channels.upstreamBudget,
          upstreamThreshold: channels.upstreamThreshold,
        });
      if (channelDeduct.length > 0) {
        const threshold =
          channelDeduct[0]!.upstreamThreshold != null
            ? toDecimal(channelDeduct[0]!.upstreamThreshold)
            : new Decimal(0);
        if (toDecimal(channelDeduct[0]!.upstreamBudget).lte(threshold)) {
          await tx
            .update(channels)
            .set({ status: 3, updatedAt: sql`clock_timestamp()` })
            .where(and(eq(channels.id, data.channelId), eq(channels.status, 0)));
          channelCircuitBroken = true;
        }
      }
    }
  });

  const finalOutcome = outcome as SettleClaimResult['outcome'];
  return {
    outcome: finalOutcome,
    settled: finalOutcome === 'settled',
    amount,
    calculatedAmount,
    channelCircuitBroken,
  };
}

/** TPM 回填是提交后的 best-effort 投影，不参与资金事务。 */
export async function backfillTpm(redis: Redis | null, data: UsageReceipt): Promise<void> {
  if (!redis) return;
  const inputTokens = Math.max(0, data.usage.inputTokens);
  const cachedInput = Math.min(Math.max(0, data.usage.cachedInputTokens), inputTokens);
  const totalTokens = inputTokens - cachedInput + Math.max(0, data.usage.outputTokens);
  const dimensions = [`user:${data.userId}:model:${data.mappingId}`, `model:${data.mappingId}`];
  if (data.apiKeyId) dimensions.push(`key:${data.apiKeyId}`);
  if (data.appId) dimensions.push(`app:${data.appId}`);
  if (data.channelId) dimensions.push(`channel:${data.channelId}`);
  try {
    const minute = Math.floor(Date.now() / 60_000);
    const script = `
      if redis.call('EXISTS', KEYS[2]) == 1 then
        return 0
      end
      local values = redis.call('HGETALL', KEYS[1])
      local increments = {}
      for i = 1, #values, 2 do
        local reservedKey = values[i]
        local current = tonumber(redis.call('GET', reservedKey) or '0')
        local amount = tonumber(values[i + 1])
        local actualKey = string.gsub(reservedKey, ':reserved:', ':actual:', 1)
        table.insert(increments, reservedKey)
        table.insert(increments, tostring(math.max(0, current - amount)))
        table.insert(increments, actualKey)
      end
      if #values == 0 then
        for i = 3, #KEYS do
          table.insert(increments, '')
          table.insert(increments, '')
          table.insert(increments, KEYS[i])
        end
      end
      redis.call('SET', KEYS[2], '1', 'EX', 86400)
      for i = 1, #increments, 3 do
        if increments[i] ~= '' then
          redis.call('SET', increments[i], increments[i + 1], 'EX', 600)
        end
        redis.call('INCRBY', increments[i + 2], tonumber(ARGV[1]))
        redis.call('EXPIRE', increments[i + 2], 600)
      end
      redis.call('DEL', KEYS[1])
      return 1
    `;
    const actualKeys = dimensions.map((dimension) => `{tpm}:actual:${minute}:${dimension}`);
    await redis.eval(
      script,
      actualKeys.length + 2,
      `{tpm}:request:${data.requestId}`,
      `{tpm}:projected:${data.requestId}`,
      ...actualKeys,
      totalTokens,
    );
  } catch {
    // Redis 故障只影响限流参考投影。
  }
}
